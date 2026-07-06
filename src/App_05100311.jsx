import React, { useState, useEffect, useMemo } from 'react';
import { initializeApp } from 'firebase/app';
import {
  getFirestore,
  collection,
  onSnapshot,
  doc,
  addDoc,
  deleteDoc,
  updateDoc,
  setDoc,
  Timestamp,
  runTransaction
} from 'firebase/firestore';

const firebaseConfig = {
  apiKey: 'AIzaSyCqq6mE7gSzNBnpqsjUAFytjs1EYvndHvY',
  authDomain: 'mytravelplan-5e252.firebaseapp.com',
  projectId: 'mytravelplan-5e252',
  storageBucket: 'mytravelplan-5e252.firebasestorage.app',
  messagingSenderId: '926305088810',
  appId: '1:926305088810:web:498d4d4ec37c73fbfa9a53'
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

const venues = ['中山', '市政府', 'KAT', '線上'];
const unavailableTypes = ['私事', '教學', '工作', '其他'];

const CLASS_DURATION = 60;
const MAX_CLASSES_PER_DAY = 8;
const REST_AFTER_CLASS_HOURS = 4;
const IDEAL_REST_MINUTES = 60;
const MIN_REST_MINUTES = 30;

const WEEKDAY_START_HOUR = 8;
const WEEKDAY_LAST_START_HOUR = 21;
const WEEKDAY_LAST_START_MINUTE = 30;

const SATURDAY_START_HOUR = 8;
const SATURDAY_LAST_START_HOUR = 11;
const SATURDAY_LAST_START_MINUTE = 0;

const formatLocalDate = (date) => {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
};

const formatLocalTime = (date) => {
  return date.toLocaleTimeString('zh-TW', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
};

const getTotalMinutes = (date) => date.getHours() * 60 + date.getMinutes();

const toTimeStr = (hour, minute = 0) => {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
};

const createDateTime = (dateStr, timeStr) => new Date(`${dateStr}T${timeStr}:00`);

const getTodayStr = () => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return formatLocalDate(today);
};

const isPastDate = (dateStr) => dateStr < getTodayStr();

const normalizeVenueForTravel = (venue) => {
  if (venue === '線上') return '中山';
  return venue;
};

const isPrivateUnavailable = (item) => (item.type || '私事') === '私事';
const isClassLikeUnavailable = (item) => !isPrivateUnavailable(item);

const isSameSlot = (a, b) => {
  return a.dateStr === b.dateStr && a.venue === b.venue && a.timeStr === b.timeStr;
};

const isSameTimeAndVenue = (a, b) => a.venue === b.venue && a.timeStr === b.timeStr;

const getRequiredGapMinutes = (venueA, venueB) => {
  const a = normalizeVenueForTravel(venueA);
  const b = normalizeVenueForTravel(venueB);

  // 同一個交通區域：只需要課程本身不要重疊，不加通勤緩衝。
  if (a === b) return CLASS_DURATION;

  const isKatToCityHall =
    (a === 'KAT' && b === '市政府') ||
    (a === '市政府' && b === 'KAT');

  if (isKatToCityHall) {
    // KAT ↔ 市政府：課程 60 分鐘 + 空堂 30 分鐘。
    return 90;
  }

  // 其他跨場地：課程 60 分鐘 + 空堂 60 分鐘。
  return 120;
};

const hasScheduleConflict = (slotA, slotB) => {
  if (slotA.dateStr !== slotB.dateStr) return false;

  const diff = Math.abs(slotA.totalMinutes - slotB.totalMinutes);

  // 私事只擋住該小時本身，不拿來計算跨場地通勤。
  if (slotA.kind === 'private' || slotB.kind === 'private') {
    return diff < CLASS_DURATION;
  }

  const sameTravelArea =
    normalizeVenueForTravel(slotA.venue) === normalizeVenueForTravel(slotB.venue);

  if (sameTravelArea) return diff < CLASS_DURATION;

  return diff < getRequiredGapMinutes(slotA.venue, slotB.venue);
};

const createDefaultSlotsForDate = (dateStr) => {
  const date = new Date(`${dateStr}T00:00:00`);
  const day = date.getDay();

  // 週日不開放。
  if (day === 0) return [];

  let startHour;
  let lastHour;
  let lastMinute;

  if (day === 6) {
    startHour = SATURDAY_START_HOUR;
    lastHour = SATURDAY_LAST_START_HOUR;
    lastMinute = SATURDAY_LAST_START_MINUTE;
  } else {
    startHour = WEEKDAY_START_HOUR;
    lastHour = WEEKDAY_LAST_START_HOUR;
    lastMinute = WEEKDAY_LAST_START_MINUTE;
  }

  const slots = [];

  for (let hour = startHour; hour <= lastHour; hour++) {
    for (const minute of [0, 30]) {
      if (hour === lastHour && minute > lastMinute) continue;

      const timeStr = toTimeStr(hour, minute);
      const jsDate = createDateTime(dateStr, timeStr);

      venues.forEach((venue) => {
        slots.push({
          venue,
          timeStr,
          dateStr,
          jsDate,
          totalMinutes: getTotalMinutes(jsDate)
        });
      });
    }
  }

  return slots;
};

const getWeekDaysFromCurrentMonday = () => {
  const today = new Date();
  const day = today.getDay();
  const diffToMonday = day === 0 ? -6 : 1 - day;
  const monday = new Date(today);
  monday.setDate(today.getDate() + diffToMonday);
  monday.setHours(0, 0, 0, 0);

  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    days.push(d);
  }
  return days;
};

const getTwoWeekDaysFromCurrentMonday = () => {
  const week = getWeekDaysFromCurrentMonday();
  const monday = week[0];
  const days = [];
  for (let i = 0; i < 14; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    days.push(d);
  }
  return days;
};

const getNextWeekDaysFromCurrentMonday = () => {
  const week = getWeekDaysFromCurrentMonday();
  const monday = week[0];
  const days = [];
  for (let i = 7; i < 14; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    days.push(d);
  }
  return days;
};

const formatDateTimeLocal = (date) => {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}`;
};

const getDefaultWizardCutoff = () => {
  const nextWeek = getNextWeekDaysFromCurrentMonday();
  const cutoff = new Date(nextWeek[0]);
  cutoff.setHours(0, 0, 0, 0);
  return formatDateTimeLocal(cutoff);
};

const getNextTwoWeekDays = () => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = [];
  for (let i = 0; i < 14; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    days.push(d);
  }
  return days;
};

const getMonthDaysMondayFirst = (year, month) => {
  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  const jsDay = firstDay.getDay();
  const startPadding = jsDay === 0 ? 6 : jsDay - 1;
  const days = [];

  for (let i = 0; i < startPadding; i++) days.push(null);
  for (let d = 1; d <= lastDay.getDate(); d++) days.push(new Date(year, month, d));

  return days;
};

const parseFirestoreTimeDoc = (id, docData) => {
  if (!docData.time) return null;
  const jsDate = docData.time.toDate();
  return {
    id,
    ...docData,
    dateStr: formatLocalDate(jsDate),
    timeStr: formatLocalTime(jsDate),
    totalMinutes: getTotalMinutes(jsDate),
    jsDate
  };
};

const getStudentWeeklyLessons = (student) => {
  const raw = student.weeklyLessons ?? student.lessonsPerWeek ?? 1;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 1;
};

const getClassLikeBlocks = (bookings, unavailable, planned = [], dateStr) => {
  const bookingBlocks = bookings
    .filter((b) => b.dateStr === dateStr)
    .map((b) => ({ ...b, kind: 'booking' }));

  const unavailableBlocks = unavailable
    .filter((u) => u.dateStr === dateStr)
    .map((u) => ({
      ...u,
      kind: isPrivateUnavailable(u) ? 'private' : 'classLikeUnavailable'
    }));

  const plannedBlocks = planned
    .filter((p) => p.dateStr === dateStr)
    .map((p) => ({ ...p, kind: 'planned' }));

  return [...bookingBlocks, ...unavailableBlocks, ...plannedBlocks];
};

const countWorkloadBlocks = (bookings, unavailable, planned, dateStr) => {
  const bookingsCount = bookings.filter((b) => b.dateStr === dateStr).length;
  const unavailableClassLikeCount = unavailable.filter(
    (u) => u.dateStr === dateStr && isClassLikeUnavailable(u)
  ).length;
  const plannedCount = planned.filter((p) => p.dateStr === dateStr).length;
  return bookingsCount + unavailableClassLikeCount + plannedCount;
};

const getWorkVenuesOfDay = (bookings, unavailable, planned, dateStr) => {
  const venueSet = new Set();

  bookings
    .filter((b) => b.dateStr === dateStr)
    .forEach((b) => venueSet.add(normalizeVenueForTravel(b.venue)));

  unavailable
    .filter((u) => u.dateStr === dateStr && isClassLikeUnavailable(u))
    .forEach((u) => venueSet.add(normalizeVenueForTravel(u.venue)));

  planned
    .filter((p) => p.dateStr === dateStr)
    .forEach((p) => venueSet.add(normalizeVenueForTravel(p.venue)));

  return [...venueSet];
};

const analyzeRest = (bookings, unavailable, planned, dateStr) => {
  const classLike = [
    ...bookings.filter((b) => b.dateStr === dateStr),
    ...unavailable.filter((u) => u.dateStr === dateStr && isClassLikeUnavailable(u)),
    ...planned.filter((p) => p.dateStr === dateStr)
  ].sort((a, b) => a.totalMinutes - b.totalMinutes);

  if (classLike.length === 0) {
    return { count: 0, maxGap: 0, level: 'empty', text: '無課' };
  }

  let maxGap = 0;
  for (let i = 0; i < classLike.length - 1; i++) {
    const end = classLike[i].totalMinutes + CLASS_DURATION;
    const gap = classLike[i + 1].totalMinutes - end;
    if (gap > maxGap) maxGap = gap;
  }

  if (classLike.length >= REST_AFTER_CLASS_HOURS) {
    if (maxGap >= IDEAL_REST_MINUTES) {
      return { count: classLike.length, maxGap, level: 'good', text: '有至少 1 小時休息' };
    }
    if (maxGap >= MIN_REST_MINUTES) {
      return { count: classLike.length, maxGap, level: 'tight', text: '只有 30 分鐘以上休息，偏緊' };
    }
    return { count: classLike.length, maxGap, level: 'bad', text: '連續課太多，缺少休息' };
  }

  return { count: classLike.length, maxGap, level: 'ok', text: '未達 4 小時課量' };
};

const App = () => {
  const today = new Date();

  const [mode, setMode] = useState('student');
  const [adminTab, setAdminTab] = useState('schedule');

  const [adminYear, setAdminYear] = useState(today.getFullYear());
  const [adminMonth, setAdminMonth] = useState(today.getMonth());

  const [selectedDates, setSelectedDates] = useState([formatLocalDate(today)]);
  const [adminSelectedDate, setAdminSelectedDate] = useState(formatLocalDate(today));

  const [selectedStudentId, setSelectedStudentId] = useState('');
  const [pendingAvailabilitySlots, setPendingAvailabilitySlots] = useState([]);

  const [students, setStudents] = useState([]);
  const [studentAvailable, setStudentAvailable] = useState([]);
  const [studentBookings, setStudentBookings] = useState([]);
  const [coachUnavailable, setCoachUnavailable] = useState([]);

  const [adminDate, setAdminDate] = useState(formatLocalDate(today));
  const [adminTime, setAdminTime] = useState('08:00');
  const [adminVenue, setAdminVenue] = useState('中山');
  const [adminUnavailableType, setAdminUnavailableType] = useState('私事');

  const [studentPage, setStudentPage] = useState(1);
  const [newStudentName, setNewStudentName] = useState('');
  const [newStudentPrice, setNewStudentPrice] = useState('');
  const [newStudentWeeklyLessons, setNewStudentWeeklyLessons] = useState('1');
  const [newStudentVenues, setNewStudentVenues] = useState([]);

  const [editingUnavailableId, setEditingUnavailableId] = useState('');
  const [editingDate, setEditingDate] = useState('');
  const [editingTime, setEditingTime] = useState('');
  const [editingVenue, setEditingVenue] = useState('中山');
  const [editingType, setEditingType] = useState('私事');

  const [wizardCutoff, setWizardCutoff] = useState(getDefaultWizardCutoff());
  const [wizardPlan, setWizardPlan] = useState([]);
  const [wizardUnscheduled, setWizardUnscheduled] = useState([]);

  useEffect(() => {
    const unsubscribeStudents = onSnapshot(collection(db, 'student'), (snapshot) => {
      const data = snapshot.docs.map((d) => {
        const docData = d.data();
        return {
          id: d.id,
          name: docData.name || '',
          venues: Array.isArray(docData.venues)
            ? docData.venues
            : docData.venue
            ? [docData.venue]
            : [],
          price: docData.price || '',
          weeklyLessons: docData.weeklyLessons ?? docData.lessonsPerWeek ?? 1,
          ...docData
        };
      });
      setStudents(data);
    });

    const unsubscribeAvailable = onSnapshot(collection(db, 'studentAvailable'), (snapshot) => {
      const data = snapshot.docs
        .map((d) => parseFirestoreTimeDoc(d.id, d.data()))
        .filter(Boolean);
      setStudentAvailable(data);
    });

    const unsubscribeBookings = onSnapshot(collection(db, 'studentBookings'), (snapshot) => {
      const data = snapshot.docs
        .map((d) => parseFirestoreTimeDoc(d.id, d.data()))
        .filter(Boolean);
      setStudentBookings(data);
    });

    const unsubscribeUnavailable = onSnapshot(collection(db, 'coachUnavailable'), (snapshot) => {
      const data = snapshot.docs
        .map((d) => parseFirestoreTimeDoc(d.id, d.data()))
        .filter(Boolean)
        .map((item) => ({ ...item, type: item.type || '私事' }));
      setCoachUnavailable(data);
    });

    const unsubscribeSchedulerSettings = onSnapshot(doc(db, 'settings', 'scheduler'), (snapshot) => {
      if (snapshot.exists()) {
        const data = snapshot.data();
        if (data.wizardCutoff) setWizardCutoff(data.wizardCutoff);
      }
    });

    return () => {
      unsubscribeStudents();
      unsubscribeAvailable();
      unsubscribeBookings();
      unsubscribeUnavailable();
      unsubscribeSchedulerSettings();
    };
  }, []);

  const selectedStudent = useMemo(() => {
    return students.find((s) => s.id === selectedStudentId) || null;
  }, [students, selectedStudentId]);

  const selectedStudentVenues = selectedStudent?.venues || [];

  const twoWeekDays = useMemo(() => getTwoWeekDaysFromCurrentMonday(), []);
  const currentWeekDays = useMemo(() => getWeekDaysFromCurrentMonday(), []);
  const currentWeekDateStrs = useMemo(() => currentWeekDays.map(formatLocalDate), [currentWeekDays]);
  const nextWeekDays = useMemo(() => getNextWeekDaysFromCurrentMonday(), []);
  const nextWeekDateStrs = useMemo(() => nextWeekDays.map(formatLocalDate), [nextWeekDays]);
  const nextTwoWeekDateStrs = useMemo(() => getNextTwoWeekDays().map(formatLocalDate), []);

  const adminSelectedDateBookings = useMemo(() => {
    return studentBookings.filter((b) => b.dateStr === adminSelectedDate);
  }, [studentBookings, adminSelectedDate]);

  const adminSelectedDateUnavailable = useMemo(() => {
    return coachUnavailable.filter((u) => u.dateStr === adminSelectedDate);
  }, [coachUnavailable, adminSelectedDate]);

  const checkStudentAvailabilityDisabled = (slot) => {
    if (isAvailabilityClosed()) return true;

    const date = new Date(`${slot.dateStr}T00:00:00`);
    if (isPastDate(slot.dateStr)) return true;
    if (date.getDay() === 0) return true;

    return false;
  };

  const getStudentAvailabilityStatusText = (slot) => {
    if (isAvailabilityClosed()) return '已截止';
    if (isPastDate(slot.dateStr)) return '無法填寫';

    const date = new Date(`${slot.dateStr}T00:00:00`);
    if (date.getDay() === 0) return '休息';

    const alreadySent = studentAvailable.some((item) => {
      return (
        item.studentId === selectedStudentId &&
        item.dateStr === slot.dateStr &&
        item.venue === slot.venue &&
        item.timeStr === slot.timeStr
      );
    });

    if (alreadySent) return '已送出';
    return '可填寫';
  };

  const getStudentDateStatus = (dateStr) => {
    const date = new Date(`${dateStr}T00:00:00`);
    const day = date.getDay();
    if (isPastDate(dateStr)) return '無法填寫';
    if (day === 0) return '休息';
    return '';
  };

  const getAdminDateStatus = (dateStr) => {
    const date = new Date(`${dateStr}T00:00:00`);
    if (date.getDay() === 0) return '休息';

    const workCount = countWorkloadBlocks(studentBookings, coachUnavailable, [], dateStr);
    if (workCount >= MAX_CLASSES_PER_DAY) return '滿8堂';

    return '';
  };

  const isAvailabilityClosed = () => {
    if (!wizardCutoff) return false;
    return new Date() >= new Date(wizardCutoff);
  };

  const handleSaveWizardCutoff = async () => {
    if (!wizardCutoff) {
      alert('請設定截止時間');
      return;
    }

    await setDoc(doc(db, 'settings', 'scheduler'), { wizardCutoff }, { merge: true });
    alert('已儲存選課截止時間');
  };

  const toggleSelectedDate = (dateStr) => {
    if (isAvailabilityClosed()) return;
    if (isPastDate(dateStr)) return;

    setSelectedDates((prev) => {
      if (prev.includes(dateStr)) {
        const next = prev.filter((d) => d !== dateStr);
        return next.length > 0 ? next : prev;
      }
      return [...prev, dateStr].sort();
    });

    setPendingAvailabilitySlots([]);
  };

  const togglePendingAvailabilitySlot = (slot) => {
    if (checkStudentAvailabilityDisabled(slot)) return;

    const isSelected = pendingAvailabilitySlots.some((s) => isSameSlot(s, slot));
    if (isSelected) {
      setPendingAvailabilitySlots((prev) => prev.filter((s) => !isSameSlot(s, slot)));
      return;
    }

    setPendingAvailabilitySlots((prev) =>
      [...prev, slot].sort((a, b) => {
        if (a.dateStr !== b.dateStr) return a.dateStr.localeCompare(b.dateStr);
        if (a.venue !== b.venue) return a.venue.localeCompare(b.venue, 'zh-Hant');
        return a.totalMinutes - b.totalMinutes;
      })
    );
  };

  const handleConfirmAvailability = async () => {
    if (isAvailabilityClosed()) {
      alert('已超過選課截止時間，無法再送出可上課時間');
      return;
    }

    if (!selectedStudent) {
      alert('請先選擇學生');
      return;
    }

    if (pendingAvailabilitySlots.length === 0) {
      alert('請先選擇至少一個可上課時間');
      return;
    }

    const newItems = pendingAvailabilitySlots.filter((slot) => {
      return !studentAvailable.some((item) => {
        return (
          item.studentId === selectedStudent.id &&
          item.dateStr === slot.dateStr &&
          item.venue === slot.venue &&
          item.timeStr === slot.timeStr
        );
      });
    });

    if (newItems.length === 0) {
      alert('選到的時間都已經送出過了');
      setPendingAvailabilitySlots([]);
      return;
    }

    try {
      await runTransaction(db, async (transaction) => {
        newItems.forEach((slot) => {
          const ref = doc(collection(db, 'studentAvailable'));
          transaction.set(ref, {
            studentId: selectedStudent.id,
            name: selectedStudent.name,
            time: Timestamp.fromDate(slot.jsDate),
            venue: slot.venue,
            status: 'available'
          });
        });
      });

      alert(`已送出 ${newItems.length} 個可上課時間`);
      setPendingAvailabilitySlots([]);
    } catch (error) {
      alert(error.message);
    }
  };

  const handleClearStudentAvailabilityInTwoWeeks = async () => {
    if (!selectedStudent) {
      alert('請先選擇學生');
      return;
    }

    const twoWeekDateStrs = twoWeekDays.map(formatLocalDate);
    const targets = studentAvailable.filter(
      (item) => item.studentId === selectedStudent.id && twoWeekDateStrs.includes(item.dateStr)
    );

    if (targets.length === 0) {
      alert('這位學生本週與下週沒有已送出的可用時間');
      return;
    }

    await Promise.all(targets.map((item) => deleteDoc(doc(db, 'studentAvailable', item.id))));
    alert('已清空這位學生本週與下週的可用時間');
  };

  const handleAddCoachUnavailable = async () => {
    if (!adminDate || !adminTime || !adminVenue || !adminUnavailableType) {
      alert('請填完整日期、時間、場地與類型');
      return;
    }

    const jsDate = createDateTime(adminDate, adminTime);

    const duplicated = coachUnavailable.some((u) => {
      return u.dateStr === adminDate && u.timeStr === adminTime && u.venue === adminVenue;
    });

    if (duplicated) {
      alert('這個不可預約時段已經存在');
      return;
    }

    await addDoc(collection(db, 'coachUnavailable'), {
      booked: true,
      type: adminUnavailableType,
      time: Timestamp.fromDate(jsDate),
      venue: adminVenue
    });

    alert('已新增教練不可預約時間');
  };

  const handleCancelBooking = async (booking) => {
    await deleteDoc(doc(db, 'studentBookings', booking.id));
    alert('已取消學生正式排課');
  };

  const handleDeleteUnavailable = async (item) => {
    await deleteDoc(doc(db, 'coachUnavailable', item.id));
    alert('已刪除教練不可預約時間');
  };

  const startEditUnavailable = (item) => {
    setEditingUnavailableId(item.id);
    setEditingDate(item.dateStr);
    setEditingTime(item.timeStr);
    setEditingVenue(item.venue);
    setEditingType(item.type || '私事');
  };

  const handleUpdateUnavailable = async () => {
    if (!editingUnavailableId || !editingDate || !editingTime || !editingVenue || !editingType) {
      alert('請填完整資料');
      return;
    }

    const jsDate = createDateTime(editingDate, editingTime);

    await updateDoc(doc(db, 'coachUnavailable', editingUnavailableId), {
      booked: true,
      type: editingType,
      time: Timestamp.fromDate(jsDate),
      venue: editingVenue
    });

    alert('已更新教練不可預約時間');
    setEditingUnavailableId('');
    setEditingDate('');
    setEditingTime('');
    setEditingVenue('中山');
    setEditingType('私事');
  };

  const handleToggleStudentVenue = async (student, venue) => {
    const currentVenues = Array.isArray(student.venues) ? student.venues : [];
    const nextVenues = currentVenues.includes(venue)
      ? currentVenues.filter((v) => v !== venue)
      : [...currentVenues, venue];

    await updateDoc(doc(db, 'student', student.id), { venues: nextVenues });
  };

  const handleToggleNewStudentVenue = (venue) => {
    setNewStudentVenues((prev) => {
      if (prev.includes(venue)) return prev.filter((v) => v !== venue);
      return [...prev, venue];
    });
  };

  const handleAddStudent = async () => {
    if (!newStudentName.trim()) {
      alert('請輸入學生姓名');
      return;
    }

    await addDoc(collection(db, 'student'), {
      name: newStudentName.trim(),
      venues: newStudentVenues,
      price: newStudentPrice.trim(),
      weeklyLessons: Number(newStudentWeeklyLessons) || 1
    });

    alert('已新增學生');
    setNewStudentName('');
    setNewStudentPrice('');
    setNewStudentWeeklyLessons('1');
    setNewStudentVenues([]);
  };

  const updateStudentWeeklyLessons = async (student, value) => {
    const n = Number(value) || 1;
    await updateDoc(doc(db, 'student', student.id), { weeklyLessons: n });
  };

  const selectedAvailabilitySlots = useMemo(() => {
    if (!selectedStudent) return [];

    return selectedDates
      .flatMap((dateStr) =>
        createDefaultSlotsForDate(dateStr)
          .filter((slot) => selectedStudentVenues.includes(slot.venue))
          .map((slot) => ({ ...slot, dateStr }))
      )
      .sort((a, b) => {
        if (a.dateStr !== b.dateStr) return a.dateStr.localeCompare(b.dateStr);
        if (a.venue !== b.venue) return a.venue.localeCompare(b.venue, 'zh-Hant');
        return a.totalMinutes - b.totalMinutes;
      });
  }, [selectedDates, selectedStudent, selectedStudentVenues]);

  const groupedAvailabilitySlots = selectedAvailabilitySlots.reduce((acc, slot) => {
    const key = `${slot.dateStr}-${slot.venue}`;
    if (!acc[key]) acc[key] = { dateStr: slot.dateStr, venue: slot.venue, slots: [] };
    acc[key].slots.push(slot);
    return acc;
  }, {});

  const sortedStudents = [...students].sort((a, b) =>
    (a.name || '').localeCompare(b.name || '', 'zh-Hant')
  );

  const studentsPerPage = 10;
  const totalStudentPages = Math.max(1, Math.ceil(sortedStudents.length / studentsPerPage));
  const currentStudents = sortedStudents.slice(
    (studentPage - 1) * studentsPerPage,
    studentPage * studentsPerPage
  );

  const monthDays = getMonthDaysMondayFirst(adminYear, adminMonth);

  const nextTwoWeekUnavailable = coachUnavailable
    .filter((u) => nextTwoWeekDateStrs.includes(u.dateStr))
    .sort((a, b) => {
      if (a.dateStr !== b.dateStr) return a.dateStr.localeCompare(b.dateStr);
      return a.totalMinutes - b.totalMinutes;
    });

  const adminDaySchedule = [
    ...adminSelectedDateBookings.map((item) => ({ ...item, typeLabel: '正式排課', kind: 'booking' })),
    ...adminSelectedDateUnavailable.map((item) => ({
      ...item,
      typeLabel: `教練不可：${item.type || '私事'}`,
      kind: 'unavailable'
    }))
  ].sort((a, b) => a.totalMinutes - b.totalMinutes);

  const scoreCandidate = (candidate, planned) => {
    let score = 0;

    const dayBlocks = getClassLikeBlocks(studentBookings, coachUnavailable, planned, candidate.dateStr);

    // 每天不跑超過兩個點。新增第三個點直接不建議。
    const venuesBefore = getWorkVenuesOfDay(studentBookings, coachUnavailable, planned, candidate.dateStr);
    const normalizedVenue = normalizeVenueForTravel(candidate.venue);
    const willAddNewVenue = !venuesBefore.includes(normalizedVenue);
    if (venuesBefore.length >= 2 && willAddNewVenue) return Infinity;
    if (willAddNewVenue) score += 25;

    // 與既有或已規劃課程衝突則不可排。
    const conflict = dayBlocks.some((block) => hasScheduleConflict(candidate, block));
    if (conflict) return Infinity;

    const workload = countWorkloadBlocks(studentBookings, coachUnavailable, planned, candidate.dateStr);
    if (workload >= MAX_CLASSES_PER_DAY) return Infinity;
    score += workload * 3;

    // 同場館、鄰近時間排一起更友善。
    const sameVenueNear = dayBlocks.some((block) => {
      const sameVenue = normalizeVenueForTravel(block.venue) === normalizeVenueForTravel(candidate.venue);
      const diff = Math.abs(block.totalMinutes - candidate.totalMinutes);
      return sameVenue && diff >= CLASS_DURATION && diff <= 120;
    });
    if (sameVenueNear) score -= 20;

    const differentVenueSameDay = dayBlocks.some((block) => {
      return normalizeVenueForTravel(block.venue) !== normalizeVenueForTravel(candidate.venue);
    });
    if (differentVenueSameDay) score += 15;

    // 同學生一週兩堂以上，避免同一天，且盡量隔一天以上。
    const sameStudentPlanned = planned.filter((p) => p.studentId === candidate.studentId);
    for (const p of sameStudentPlanned) {
      if (p.dateStr === candidate.dateStr) return Infinity;
      const dayDiff = Math.abs(
        (new Date(`${candidate.dateStr}T00:00:00`) - new Date(`${p.dateStr}T00:00:00`)) /
          (24 * 60 * 60 * 1000)
      );
      if (dayDiff >= 2) score -= 10;
      if (dayDiff === 1) score += 5;
    }

    // 休息規則：平均上 4 小時課需要進食一次，理想 1 小時，太緊至少 30 分鐘。
    const restAfter = analyzeRest(studentBookings, coachUnavailable, [...planned, candidate], candidate.dateStr);
    if (restAfter.count >= REST_AFTER_CLASS_HOURS) {
      if (restAfter.maxGap >= IDEAL_REST_MINUTES) score -= 12;
      else if (restAfter.maxGap >= MIN_REST_MINUTES) score += 35;
      else score += 120;
    }

    // 稍微偏好不要太晚，但晚課不是禁止。
    if (candidate.totalMinutes >= 20 * 60) score += 8;

    return score;
  };

  const generateWizardPlan = () => {
    const weekAvail = studentAvailable.filter((item) => nextWeekDateStrs.includes(item.dateStr));
    const planned = [];
    const unscheduled = [];

    const studentsByNeed = [...students].sort((a, b) => {
      const aCount = weekAvail.filter((x) => x.studentId === a.id).length;
      const bCount = weekAvail.filter((x) => x.studentId === b.id).length;
      return aCount - bCount;
    });

    for (const student of studentsByNeed) {
      const needed = getStudentWeeklyLessons(student);
      const candidates = weekAvail
        .filter((item) => item.studentId === student.id)
        .map((item) => ({
          ...item,
          studentId: student.id,
          name: student.name,
          kind: 'planned'
        }))
        .sort((a, b) => {
          if (a.dateStr !== b.dateStr) return a.dateStr.localeCompare(b.dateStr);
          return a.totalMinutes - b.totalMinutes;
        });

      for (let lesson = 0; lesson < needed; lesson++) {
        let best = null;
        let bestScore = Infinity;

        for (const candidate of candidates) {
          const alreadyChosen = planned.some((p) => {
            return p.studentId === candidate.studentId && p.dateStr === candidate.dateStr && p.timeStr === candidate.timeStr && p.venue === candidate.venue;
          });
          if (alreadyChosen) continue;

          const score = scoreCandidate(candidate, planned);
          if (score < bestScore) {
            bestScore = score;
            best = candidate;
          }
        }

        if (best && bestScore < Infinity) {
          planned.push({ ...best, score: bestScore });
        } else {
          unscheduled.push({
            studentId: student.id,
            name: student.name,
            reason: `下週第 ${lesson + 1} 堂找不到合適時段`
          });
        }
      }
    }

    planned.sort((a, b) => {
      if (a.dateStr !== b.dateStr) return a.dateStr.localeCompare(b.dateStr);
      if (a.totalMinutes !== b.totalMinutes) return a.totalMinutes - b.totalMinutes;
      return a.venue.localeCompare(b.venue, 'zh-Hant');
    });

    setWizardPlan(planned);
    setWizardUnscheduled(unscheduled);
  };

  const adoptWizardPlan = async () => {
    if (wizardPlan.length === 0) {
      alert('請先產生排課建議');
      return;
    }

    try {
      await runTransaction(db, async (transaction) => {
        wizardPlan.forEach((item) => {
          const exists = studentBookings.some((b) => {
            return b.studentId === item.studentId && b.dateStr === item.dateStr && b.timeStr === item.timeStr && b.venue === item.venue;
          });
          if (exists) return;

          const ref = doc(collection(db, 'studentBookings'));
          transaction.set(ref, {
            booked: true,
            name: item.name,
            studentId: item.studentId,
            time: Timestamp.fromDate(item.jsDate),
            venue: item.venue,
            source: 'wizard'
          });
        });
      });

      alert('已採用排課小精靈建議');
    } catch (error) {
      alert(error.message);
    }
  };

  const getWizardCellItems = (dateStr, hour) => {
    const start = hour * 60;
    const end = start + 60;
    return wizardPlan.filter((item) => {
      return item.dateStr === dateStr && item.totalMinutes >= start && item.totalMinutes < end;
    });
  };

  const wizardRestByDay = nextWeekDateStrs.map((dateStr) => ({
    dateStr,
    ...analyzeRest(studentBookings, coachUnavailable, wizardPlan, dateStr)
  }));

  const goPrevMonth = () => {
    const d = new Date(adminYear, adminMonth - 1, 1);
    setAdminYear(d.getFullYear());
    setAdminMonth(d.getMonth());
  };

  const goNextMonth = () => {
    const d = new Date(adminYear, adminMonth + 1, 1);
    setAdminYear(d.getFullYear());
    setAdminMonth(d.getMonth());
  };

  return (
    <div className="max-w-6xl mx-auto p-4">
      <h1 className="text-xl font-bold text-center mb-4">預約系統</h1>

      <div className="flex gap-2 mb-4 max-w-md mx-auto">
        <button
          onClick={() => setMode('student')}
          className={`flex-1 py-2 rounded ${mode === 'student' ? 'bg-indigo-600 text-white' : 'bg-gray-100'}`}
        >
          學生填可用時間
        </button>
        <button
          onClick={() => setMode('admin')}
          className={`flex-1 py-2 rounded ${mode === 'admin' ? 'bg-indigo-600 text-white' : 'bg-gray-100'}`}
        >
          教練後台
        </button>
      </div>

      {mode === 'student' && (
        <div className="max-w-md mx-auto">
          <div className="border rounded p-3 mb-5">
            <div className="font-bold mb-3 text-center">請選擇下週可上課時間</div>
            <div className="grid grid-cols-7 text-center text-xs text-gray-500 mb-2">
              <div>一</div><div>二</div><div>三</div><div>四</div><div>五</div><div>六</div><div>日</div>
            </div>
            <div className="grid grid-cols-7 gap-1">
              {twoWeekDays.map((day) => {
                const dateStr = formatLocalDate(day);
                const dateStatus = getStudentDateStatus(dateStr);
                const selected = selectedDates.includes(dateStr);
                const past = dateStatus === '無法填寫';
                return (
                  <button
                    key={dateStr}
                    disabled={past}
                    onClick={() => toggleSelectedDate(dateStr)}
                    className={`h-16 rounded border text-xs flex flex-col items-center justify-center ${
                      selected ? 'bg-indigo-600 text-white' : past ? 'bg-gray-100 text-gray-400' : dateStatus ? 'bg-gray-100 text-gray-400' : 'bg-white'
                    }`}
                  >
                    <div className="text-sm font-medium">{day.getMonth() + 1}/{day.getDate()}</div>
                    {dateStatus && <div className={`text-[10px] mt-1 ${past ? 'text-red-500' : ''}`}>{dateStatus}</div>}
                  </button>
                );
              })}
            </div>
            <div className="text-xs text-gray-500 mt-2">已選日期：{selectedDates.join('、')}</div>
          </div>

          <div className="mb-4">
            <label className="block text-sm mb-1">選擇學生</label>
            <select
              value={selectedStudentId}
              onChange={(e) => {
                setSelectedStudentId(e.target.value);
                setPendingAvailabilitySlots([]);
              }}
              className="w-full p-2 border rounded"
            >
              <option value="">請選擇學生</option>
              {students.map((student) => (
                <option key={student.id} value={student.id}>{student.name || '未命名學生'}</option>
              ))}
            </select>
          </div>

          {selectedStudent && (
            <div className="mb-4 text-sm text-gray-600">
              可上課場館：{selectedStudentVenues.length ? selectedStudentVenues.join('、') : '尚未設定'}
            </div>
          )}

          {!selectedStudent && <p className="text-center text-gray-400 mt-4 text-sm">請先選擇學生。</p>}
          {selectedStudent && selectedStudentVenues.length === 0 && <p className="text-center text-gray-400 mt-4 text-sm">此學生尚未設定上課場館。</p>}

          {Object.values(groupedAvailabilitySlots).map((group) => (
            <div key={`${group.dateStr}-${group.venue}`} className="mb-5">
              <h2 className="font-bold mb-2">{group.dateStr}｜{group.venue}</h2>
              <div className="grid grid-cols-2 gap-2">
                {group.slots.map((slot) => {
                  const disabled = checkStudentAvailabilityDisabled(slot);
                  const selected = pendingAvailabilitySlots.some((s) => isSameSlot(s, slot));
                  const statusText = getStudentAvailabilityStatusText(slot);
                  return (
                    <button
                      key={`${slot.dateStr}-${slot.venue}-${slot.timeStr}`}
                      disabled={disabled}
                      onClick={() => togglePendingAvailabilitySlot(slot)}
                      className={`p-3 border rounded text-sm ${
                        disabled ? 'bg-gray-50 text-gray-300' : selected ? 'bg-gray-300 text-gray-900 border-gray-500' : statusText === '已送出' ? 'bg-green-50 border-green-200' : 'bg-white border-indigo-200 hover:bg-indigo-50'
                      }`}
                    >
                      <div>{slot.timeStr}</div>
                      <div className="text-xs mt-1">{selected ? '已選擇' : statusText}</div>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}

          {selectedStudent && (
            <div className="sticky bottom-4 bg-white border rounded p-3 shadow-lg">
              <div className="text-sm font-bold mb-2">已選擇 {pendingAvailabilitySlots.length} 個可上課時間</div>
              <div className="text-xs text-gray-600 mb-3 space-y-1 max-h-28 overflow-auto">
                {pendingAvailabilitySlots.map((slot) => (
                  <div key={`${slot.dateStr}-${slot.venue}-${slot.timeStr}`}>{slot.dateStr}｜{slot.venue}｜{slot.timeStr}</div>
                ))}
              </div>
              <button onClick={handleConfirmAvailability} className="w-full py-2 rounded bg-indigo-600 text-white">送出可上課時間</button>
              <button onClick={() => setPendingAvailabilitySlots([])} className="w-full py-2 rounded bg-gray-100 mt-2">清空本次選擇</button>
              <button onClick={handleClearStudentAvailabilityInTwoWeeks} className="w-full py-2 rounded bg-red-50 text-red-600 mt-2">清空我本週與下週已送出的時間</button>
            </div>
          )}
        </div>
      )}

      {mode === 'admin' && (
        <>
          <div className="flex justify-center gap-2 mb-4 overflow-auto">
            {[
              ['schedule', '時間表'],
              ['students', '學生管理'],
              ['availability', '可用時間'],
              ['wizard', '排課小精靈']
            ].map(([key, label]) => (
              <button
                key={key}
                onClick={() => setAdminTab(key)}
                className={`min-w-[92px] py-2 rounded text-sm ${adminTab === key ? 'bg-indigo-600 text-white' : 'bg-gray-100'}`}
              >
                {label}
              </button>
            ))}
          </div>

          {adminTab === 'schedule' && (
            <div className="max-w-md mx-auto">
              <div className="border rounded p-3 mb-5">
                <div className="flex justify-between items-center mb-3">
                  <button onClick={goPrevMonth} className="px-3 py-1 bg-gray-100 rounded">上月</button>
                  <div className="font-bold">{adminYear} 年 {adminMonth + 1} 月</div>
                  <button onClick={goNextMonth} className="px-3 py-1 bg-gray-100 rounded">下月</button>
                </div>
                <div className="grid grid-cols-7 text-center text-xs text-gray-500 mb-2">
                  <div>一</div><div>二</div><div>三</div><div>四</div><div>五</div><div>六</div><div>日</div>
                </div>
                <div className="grid grid-cols-7 gap-1">
                  {monthDays.map((day, index) => {
                    if (!day) return <div key={index} className="h-16" />;
                    const dateStr = formatLocalDate(day);
                    const dateStatus = getAdminDateStatus(dateStr);
                    const selected = adminSelectedDate === dateStr;
                    return (
                      <button
                        key={dateStr}
                        onClick={() => {
                          setAdminSelectedDate(dateStr);
                          setAdminDate(dateStr);
                        }}
                        className={`h-16 rounded border text-xs flex flex-col items-center justify-center ${selected ? 'bg-indigo-600 text-white' : dateStatus ? 'bg-gray-100 text-gray-400' : 'bg-white'}`}
                      >
                        <div className="text-sm font-medium">{day.getDate()}</div>
                        {dateStatus && <div className={`text-[10px] mt-1 ${selected ? 'text-white' : 'text-red-500'}`}>{dateStatus}</div>}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="mb-3 text-sm text-gray-600">查看日期：{adminSelectedDate}</div>
              <h2 className="font-bold mb-2">當天行程表</h2>
                            <div className="space-y-2 mb-5">
                {adminDaySchedule.length === 0 && (
                  <p className="text-sm text-gray-400">此日期沒有任何行程</p>
                )}

                {adminDaySchedule.map((item) => (
                  <div
                    key={`${item.kind}-${item.id}`}
                    className={`border rounded p-3 flex justify-between items-center ${
                      item.kind === 'unavailable' ? 'bg-gray-50' : 'bg-white'
                    }`}
                  >
                    <div>
                      <div className="font-medium">
                        {item.venue}｜{item.timeStr}
                      </div>
                      <div className="text-sm text-gray-500">
                        {item.kind === 'booking'
                          ? `學生：${item.name || '未填姓名'}`
                          : item.typeLabel}
                      </div>
                    </div>

                    {item.kind === 'booking' ? (
                      <button
                        onClick={() => handleCancelBooking(item)}
                        className="text-sm px-3 py-1 rounded bg-red-100 text-red-600"
                      >
                        取消
                      </button>
                    ) : (
                      <button
                        onClick={() => handleDeleteUnavailable(item)}
                        className="text-sm px-3 py-1 rounded bg-red-100 text-red-600"
                      >
                        刪除
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {adminTab === 'wizard' && (
            <div>
              <div className="max-w-md mx-auto border rounded p-4 bg-gray-50 mb-5">
                <h2 className="font-bold mb-2">排課小精靈</h2>

                <p className="text-sm text-gray-600 mb-3">
                  依據學生填寫的下週可上課時間，自動嘗試安排下週課表。
                  排序目標：先讓大家上到課，再減少教練奔波，並盡量安排休息。
                </p>

                <div className="mb-3">
                  <label className="block text-sm mb-1">
                    學生選課截止時間
                  </label>
                  <input
                    type="datetime-local"
                    value={wizardCutoff}
                    onChange={(e) => setWizardCutoff(e.target.value)}
                    className="w-full p-2 border rounded"
                  />
                  <p className="text-xs text-gray-500 mt-1">
                    例如本週是 5/4～5/10，截止時間可設為 5/11 00:00，
                    排課小精靈會產生 5/11～5/17 的建議課表。
                  </p>
                </div>

                <button
                  onClick={handleSaveWizardCutoff}
                  className="w-full py-2 rounded bg-gray-100 mb-3"
                >
                  儲存截止時間
                </button>

                <button
                  onClick={generateWizardPlan}
                  className="w-full py-2 rounded bg-indigo-600 text-white"
                >
                  產生下週排課建議
                </button>

                <button
                  onClick={adoptWizardPlan}
                  className="w-full py-2 rounded bg-green-600 text-white mt-2"
                >
                  採用建議並寫入正式排課
                </button>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-7 gap-3 mb-5">
                {wizardRestByDay.map((item) => (
                  <div
                    key={item.dateStr}
                    className="border rounded p-3 bg-white"
                  >
                    <div className="font-bold">{item.dateStr}</div>
                    <div className="text-sm text-gray-600">
                      課量：{item.count}
                    </div>
                    <div
                      className={`text-sm ${
                        item.level === 'bad'
                          ? 'text-red-600'
                          : item.level === 'tight'
                          ? 'text-orange-600'
                          : 'text-gray-600'
                      }`}
                    >
                      {item.text}
                    </div>
                  </div>
                ))}
              </div>

              <div className="overflow-auto border rounded">
                <table className="w-full text-xs border-collapse min-w-[900px]">
                  <thead>
                    <tr className="bg-gray-100">
                      <th className="border p-2 w-16">時間</th>
                      {nextWeekDays.map((day) => (
                        <th
                          key={formatLocalDate(day)}
                          className="border p-2"
                        >
                          {formatLocalDate(day)}
                        </th>
                      ))}
                    </tr>
                  </thead>

                  <tbody>
                    {Array.from({ length: 15 }, (_, i) => 8 + i).map(
                      (hour) => (
                        <tr key={hour}>
                          <td className="border p-2 font-medium">
                            {toTimeStr(hour)}
                          </td>

                          {nextWeekDateStrs.map((dateStr) => {
                            const items = getWizardCellItems(dateStr, hour);

                            return (
                              <td
                                key={`${dateStr}-${hour}`}
                                className="border p-2 align-top h-20"
                              >
                                {items.map((item) => (
                                  <div
                                    key={`${item.studentId}-${item.dateStr}-${item.timeStr}-${item.venue}`}
                                    className="rounded bg-indigo-50 border border-indigo-100 p-1 mb-1"
                                  >
                                    <div className="font-bold">
                                      {item.timeStr} {item.name}
                                    </div>
                                    <div>{item.venue}</div>
                                  </div>
                                ))}
                              </td>
                            );
                          })}
                        </tr>
                      )
                    )}
                  </tbody>
                </table>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-5">
                <div>
                  <h2 className="font-bold mb-2">建議排課清單</h2>

                  <div className="space-y-2">
                    {wizardPlan.length === 0 && (
                      <p className="text-sm text-gray-400">尚未產生建議</p>
                    )}

                    {wizardPlan.map((item) => (
                      <div
                        key={`${item.studentId}-${item.dateStr}-${item.timeStr}-${item.venue}`}
                        className="border rounded p-3"
                      >
                        <div className="font-medium">
                          {item.dateStr}｜{item.timeStr}｜{item.venue}
                        </div>
                        <div className="text-sm text-gray-500">
                          學生：{item.name}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <div>
                  <h2 className="font-bold mb-2">未排到</h2>

                  <div className="space-y-2">
                    {wizardUnscheduled.length === 0 && (
                      <p className="text-sm text-gray-400">
                        目前沒有未排到的學生
                      </p>
                    )}

                    {wizardUnscheduled.map((item, idx) => (
                      <div
                        key={`${item.studentId}-${idx}`}
                        className="border rounded p-3 bg-red-50"
                      >
                        <div className="font-medium">{item.name}</div>
                        <div className="text-sm text-red-600">
                          {item.reason}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default App;
