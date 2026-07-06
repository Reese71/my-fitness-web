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
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut
} from 'firebase/auth';
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
const auth = getAuth(app);

const venues = ['中山', '市政府', 'KAT', '線上'];
const unavailableTypes = ['私事', '教學', '工作', '其他'];
// 越前面代表離家越近，可以依實際情況調整
const HOME_VENUE_PRIORITY = ['線上', '中山', '市政府', 'KAT'];

const getHomeVenueRank = (venue) => {
  const normalizedVenue = normalizeVenueForVenueCount(venue);
  const index = HOME_VENUE_PRIORITY.indexOf(normalizedVenue);
  return index === -1 ? HOME_VENUE_PRIORITY.length : index;
};
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
  return toTimeStr(date.getHours(), date.getMinutes());
};

const getTotalMinutes = (date) => date.getHours() * 60 + date.getMinutes();

const toTimeStr = (hour, minute = 0) => {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
};
const getWeekdayLabel = (dateStr) => {
  const date = new Date(`${dateStr}T00:00:00`);
  const labels = ['日', '一', '二', '三', '四', '五', '六'];
  return `星期${labels[date.getDay()]}`;
};
const createDateTime = (dateStr, timeStr) => new Date(`${dateStr}T${timeStr}:00`);

const getTodayStr = (baseDate = new Date()) => {
  const today = new Date(baseDate);
  today.setHours(0, 0, 0, 0);
  return formatLocalDate(today);
};

const isPastDate = (dateStr, baseDate = new Date()) => {
  return dateStr < getTodayStr(baseDate);
};

const normalizeVenueForTravel = (venue) => {
  return venue;
};

const normalizeVenueForVenueCount = (venue) => {
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

  if (a === b) return CLASS_DURATION;

  const isOnlineToZhongshan =
    (a === '線上' && b === '中山') ||
    (a === '中山' && b === '線上');

  if (isOnlineToZhongshan) {
    // 線上 ↔ 中山：課程 60 分鐘 + 交通/準備 30 分鐘
    return 90;
  }

  const isKatToCityHall =
    (a === 'KAT' && b === '市政府') ||
    (a === '市政府' && b === 'KAT');

  if (isKatToCityHall) {
    return 90;
  }

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

  // 週日不開放
  if (day === 0) return [];

  const slots = [];

  for (let hour = DAY_START_HOUR; hour <= DAY_LAST_START_HOUR; hour++) {
    for (const minute of [0, 30]) {
      if (hour === DAY_LAST_START_HOUR && minute > DAY_LAST_START_MINUTE) continue;

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

const getWeekDaysFromCurrentMonday = (baseDate = new Date()) => {
  const today = new Date(baseDate);
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

const getTwoWeekDaysFromCurrentMonday = (baseDate = new Date()) => {
  const week = getWeekDaysFromCurrentMonday(baseDate);
  const monday = week[0];
  const days = [];
  for (let i = 0; i < 14; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    days.push(d);
  }
  return days;
};

const getNextWeekDaysFromCurrentMonday = (baseDate = new Date()) => {
  const week = getWeekDaysFromCurrentMonday(baseDate);
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
const formatDisplayDateTime = (date) => {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');

  return `${yyyy}/${mm}/${dd} ${hh}:${mi}:${ss}`;
};
const getDefaultWizardCutoff = (baseDate = new Date()) => {
  const nextWeek = getNextWeekDaysFromCurrentMonday(baseDate);
  const cutoff = new Date(nextWeek[0]);
  cutoff.setHours(0, 0, 0, 0);
  return formatDateTimeLocal(cutoff);
};

const getNextTwoWeekDays = (baseDate = new Date()) => {
  const today = new Date(baseDate);
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
    .forEach((b) => venueSet.add(normalizeVenueForVenueCount(b.venue)));

  unavailable
    .filter((u) => u.dateStr === dateStr && isClassLikeUnavailable(u))
    .forEach((u) => venueSet.add(normalizeVenueForVenueCount(u.venue)));

  planned
    .filter((p) => p.dateStr === dateStr)
    .forEach((p) => venueSet.add(normalizeVenueForVenueCount(p.venue)));

  return [...venueSet];
};
const getCountedVenuesWithOnlineEdgeRule = (blocks) => {
  const sortedBlocks = [...blocks].sort((a, b) => a.totalMinutes - b.totalMinutes);
  const venueSet = new Set();

  sortedBlocks.forEach((block, index) => {
    if (!block.venue) return;

    const isOnline = block.venue === '線上';
    const isFirst = index === 0;
    const isLast = index === sortedBlocks.length - 1;

    // 線上課如果是當天第一堂或最後一堂，就不算成多跑一個地點
    if (isOnline && (isFirst || isLast)) {
      return;
    }

    // 線上課如果卡在中間，就算成一個獨立地點
    if (isOnline) {
      venueSet.add('線上');
      return;
    }

    venueSet.add(normalizeVenueForVenueCount(block.venue));
  });

  return [...venueSet];
};
const getMaxConsecutiveClasses = (blocks) => {
  const sorted = [...blocks].sort((a, b) => a.totalMinutes - b.totalMinutes);

  if (sorted.length === 0) return 0;

  let maxConsecutive = 1;
  let currentConsecutive = 1;

  for (let i = 0; i < sorted.length - 1; i++) {
    const currentEnd = sorted[i].totalMinutes + CLASS_DURATION;
    const nextStart = sorted[i + 1].totalMinutes;
    const gap = nextStart - currentEnd;

    // gap <= 0：代表下一堂緊接著，或甚至重疊
    // gap < MIN_REST_MINUTES：代表中間沒有足夠休息，也視為連續
    if (gap < MIN_REST_MINUTES) {
      currentConsecutive += 1;
      maxConsecutive = Math.max(maxConsecutive, currentConsecutive);
    } else {
      currentConsecutive = 1;
    }
  }

  return maxConsecutive;
};
const analyzeRest = (bookings, unavailable, planned, dateStr) => {
  const classLike = [
    ...bookings.filter((b) => b.dateStr === dateStr),
    ...unavailable.filter(
      (u) => u.dateStr === dateStr && isClassLikeUnavailable(u)
    ),
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

  const maxConsecutiveClasses = getMaxConsecutiveClasses(classLike);

  if (maxConsecutiveClasses >= REST_AFTER_CLASS_HOURS) {
    if (maxGap >= IDEAL_REST_MINUTES) {
      return {
        count: classLike.length,
        maxGap,
        maxConsecutiveClasses,
        level: 'good',
        text: '曾連續 4 堂以上，但有至少 1 小時休息'
      };
    }

    if (maxGap >= MIN_REST_MINUTES) {
      return {
        count: classLike.length,
        maxGap,
        maxConsecutiveClasses,
        level: 'tight',
        text: '曾連續 4 堂以上，只有 30 分鐘以上休息，偏緊'
      };
    }

    return {
      count: classLike.length,
      maxGap,
      maxConsecutiveClasses,
      level: 'bad',
      text: '連續 4 堂以上，缺少休息'
    };
  }

  return {
    count: classLike.length,
    maxGap,
    maxConsecutiveClasses,
    level: 'ok',
    text: '沒有連續 4 堂'
  };
};
const getIdleMinutesOfDay = (blocks) => {
  const sorted = [...blocks].sort((a, b) => a.totalMinutes - b.totalMinutes);

  let idle = 0;

  for (let i = 0; i < sorted.length - 1; i++) {
    const currentEnd = sorted[i].totalMinutes + CLASS_DURATION;
    const nextStart = sorted[i + 1].totalMinutes;
    const gap = nextStart - currentEnd;

    if (gap > 0) idle += gap;
  }

  return idle;
};

const hasEnoughRestAfterCandidate = (bookings, unavailable, planned, candidate) => {
  const restAfter = analyzeRest(
    bookings,
    unavailable,
    [...planned, candidate],
    candidate.dateStr
  );

  if ((restAfter.maxConsecutiveClasses || 0) < REST_AFTER_CLASS_HOURS) {
    return true;
  }

  return restAfter.maxGap >= MIN_REST_MINUTES;
};

const getTravelBufferMinutes = (a, b) => {
  if (!a || !b) return 0;

  if (a.kind === 'private' || b.kind === 'private') return 0;

  return Math.max(
    0,
    getRequiredGapMinutes(a.venue, b.venue) - CLASS_DURATION
  );
};

const getMaxRestGapExcludingTravel = (blocks) => {
  const sorted = [...blocks].sort((a, b) => a.totalMinutes - b.totalMinutes);

  let maxRest = 0;

  for (let i = 0; i < sorted.length - 1; i++) {
    const current = sorted[i];
    const next = sorted[i + 1];

    const currentEnd = current.totalMinutes + CLASS_DURATION;
    const rawGap = next.totalMinutes - currentEnd;
    const travelBuffer = getTravelBufferMinutes(current, next);
    const restGap = rawGap - travelBuffer;

    if (restGap > maxRest) maxRest = restGap;
  }

  return maxRest;
};

const hasEnoughRestForFourClasses = (blocks) => {
  const classLike = blocks
    .filter((block) => block.kind !== 'private')
    .sort((a, b) => a.totalMinutes - b.totalMinutes);

  if (classLike.length < REST_AFTER_CLASS_HOURS) return true;

  const maxConsecutiveClasses = getMaxConsecutiveClasses(classLike);

  if (maxConsecutiveClasses < REST_AFTER_CLASS_HOURS) return true;

  return getMaxRestGapExcludingTravel(classLike) >= MIN_REST_MINUTES;
};

const hasLateClassAfterEight = (blocks) => {
  return blocks.some((block) => block.totalMinutes >= 20 * 60);
};

const hasThirtyMinuteRestBetween16And17 = (blocks) => {
  const classLike = blocks
    .filter((block) => block.kind !== 'private')
    .sort((a, b) => a.totalMinutes - b.totalMinutes);

  const windowStart = 16 * 60;
  const windowEnd = 17 * 60;

  let freeStart = windowStart;

  for (const block of classLike) {
    const blockStart = block.totalMinutes;
    const blockEnd = block.totalMinutes + CLASS_DURATION;

    if (blockEnd <= windowStart) continue;
    if (blockStart >= windowEnd) break;

    const gap = blockStart - freeStart;
    if (gap >= MIN_REST_MINUTES) return true;

    freeStart = Math.max(freeStart, blockEnd);
  }

  return windowEnd - freeStart >= MIN_REST_MINUTES;
};

const App = () => {
  const [autoNow, setAutoNow] = useState(new Date());

  const [adminUser, setAdminUser] = useState(null);
  const [adminEmail, setAdminEmail] = useState('');
  const [adminPassword, setAdminPassword] = useState('');
  const [authLoading, setAuthLoading] = useState(true);
  const [manualNow, setManualNow] = useState('');

  useEffect(() => {
    if (manualNow) return;

    const timer = setInterval(() => {
      setAutoNow(new Date());
    }, 1000);

    return () => clearInterval(timer);
  }, [manualNow]);

  const currentNow = useMemo(() => {
    if (!manualNow) return autoNow;
    return new Date(manualNow);
  }, [manualNow, autoNow]);

  const today = currentNow;

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
  const [studentVenueFilter, setStudentVenueFilter] = useState('全部');
  const [newStudentName, setNewStudentName] = useState('');
  const [newStudentPrice, setNewStudentPrice] = useState('');
  const [newStudentWeeklyLessons, setNewStudentWeeklyLessons] = useState('1');
  const [newStudentVenues, setNewStudentVenues] = useState([]);

  const [editingUnavailableId, setEditingUnavailableId] = useState('');
  const [editingDate, setEditingDate] = useState('');
  const [editingTime, setEditingTime] = useState('');
  const [editingVenue, setEditingVenue] = useState('中山');
  const [editingType, setEditingType] = useState('私事');

  //const [wizardCutoff, setWizardCutoff] = useState(getDefaultWizardCutoff());
  const [wizardCutoff, setWizardCutoff] = useState('');
  const [wizardPlan, setWizardPlan] = useState([]);
  const [wizardUnscheduled, setWizardUnscheduled] = useState([]);
  const [wizardGeneratedAt, setWizardGeneratedAt] = useState('');
  const [draggingWizardItem, setDraggingWizardItem] = useState(null);
  const [availabilityPopover, setAvailabilityPopover] = useState(null);
  const [wizardContextMenu, setWizardContextMenu] = useState(null);
  const [manualWizardStudentId, setManualWizardStudentId] = useState('');
  const [manualWizardVenue, setManualWizardVenue] = useState('中山');

  useEffect(() => {
    if (!adminUser) {
      setStudentBookings([]);
      setCoachUnavailable([]);
      setStudentAvailable([]);
      return;
    }

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

    const unsubscribeAvailable = onSnapshot(
      collection(db, 'studentAvailable'),
      (snapshot) => {
        const data = snapshot.docs
          .map((d) => parseFirestoreTimeDoc(d.id, d.data()))
          .filter(Boolean);

        setStudentAvailable(data);
      },
      (error) => {
        console.error('讀取 studentAvailable 失敗：', error);
      }
    );

    return () => {
      unsubscribeBookings();
      unsubscribeUnavailable();
      unsubscribeAvailable();
    };
  }, [adminUser]);
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
    return () => {
      unsubscribeStudents();
    };
  }, []);

  useEffect(() => {
    const unsubscribeSchedulerSettings = onSnapshot(
      doc(db, 'settings', 'scheduler'),
      (snapshot) => {
        if (snapshot.exists()) {
          const data = snapshot.data();
          if (data.wizardCutoff) setWizardCutoff(data.wizardCutoff);
        }
      }
    );

    return () => unsubscribeSchedulerSettings();
  }, []);
  useEffect(() => {
    if (!wizardCutoff) {
      setWizardCutoff(getDefaultWizardCutoff(currentNow));
    }
  }, [currentNow, wizardCutoff]);
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setAdminUser(user);
      setAuthLoading(false);
    });

    return () => unsubscribe();
  }, []);
  const selectedStudent = useMemo(() => {
    return students.find((s) => s.id === selectedStudentId) || null;
  }, [students, selectedStudentId]);

  const selectedStudentVenues = selectedStudent?.venues || [];

  const twoWeekDays = useMemo(
    () => getTwoWeekDaysFromCurrentMonday(currentNow),
    [currentNow]
  );

  const currentWeekDays = useMemo(
    () => getWeekDaysFromCurrentMonday(currentNow),
    [currentNow]
  );

  const nextWeekDays = useMemo(
    () => getNextWeekDaysFromCurrentMonday(currentNow),
    [currentNow]
  );

  const nextTwoWeekDateStrs = useMemo(
    () => getNextTwoWeekDays(currentNow).map(formatLocalDate),
    [currentNow]
  );
  const currentWeekDateStrs = useMemo(() => currentWeekDays.map(formatLocalDate), [currentWeekDays]);
  const nextWeekDateStrs = useMemo(() => nextWeekDays.map(formatLocalDate), [nextWeekDays]);
  useEffect(() => {
    const todayStr = formatLocalDate(currentNow);
    const nextWeekDateStrsByNow = getNextWeekDaysFromCurrentMonday(currentNow)
      .map(formatLocalDate)
      .filter((dateStr) => {
        const date = new Date(`${dateStr}T00:00:00`);
        return date.getDay() !== 0; // 排除星期日
      });

    setAdminYear(currentNow.getFullYear());
    setAdminMonth(currentNow.getMonth());
    setAdminSelectedDate(todayStr);
    setAdminDate(todayStr);

    // 學生填課預設顯示「目前使用時間的下週」
    setSelectedDates(nextWeekDateStrsByNow);

    setPendingAvailabilitySlots([]);
  }, [manualNow]);

  const adminSelectedDateBookings = useMemo(() => {
    return studentBookings.filter((b) => b.dateStr === adminSelectedDate);
  }, [studentBookings, adminSelectedDate]);

  const adminSelectedDateUnavailable = useMemo(() => {
    return coachUnavailable.filter((u) => u.dateStr === adminSelectedDate);
  }, [coachUnavailable, adminSelectedDate]);

  const checkStudentAvailabilityDisabled = (slot) => {
    if (isAvailabilityClosed()) return true;

    const date = new Date(`${slot.dateStr}T00:00:00`);
    if (isPastDate(slot.dateStr, currentNow)) return true;
    if (date.getDay() === 0) return true;

    return false;
  };

  const getStudentAvailabilityStatusText = (slot) => {
    if (isAvailabilityClosed()) return '已截止';
    if (isPastDate(slot.dateStr, currentNow)) return '無法填寫';

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
    if (isPastDate(dateStr, currentNow)) return '無法填寫';
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
  return currentNow >= new Date(wizardCutoff);
  };

  const handleSaveWizardCutoff = async () => {
    if (!wizardCutoff) {
      alert('請設定截止時間');
      return;
    }

    await setDoc(doc(db, 'settings', 'scheduler'), { wizardCutoff }, { merge: true });
    alert('已儲存選課截止時間');
  };
  const handleAdminLogin = async () => {
    if (!adminEmail || !adminPassword) {
      alert('請輸入 Email 和密碼');
      return;
    }

    try {
      await signInWithEmailAndPassword(auth, adminEmail, adminPassword);
      setAdminPassword('');
    } catch (error) {
      alert('登入失敗，請確認帳號密碼');
    }
  };

  const handleAdminLogout = async () => {
    await signOut(auth);
  };
  const toggleSelectedDate = (dateStr) => {
    if (isAvailabilityClosed()) return;
    if (isPastDate(dateStr, currentNow)) return;

    setSelectedDates((prev) => {
      if (prev.includes(dateStr)) {
        const next = prev.filter((d) => d !== dateStr);

        if (next.length === 0) return prev;

        setPendingAvailabilitySlots((oldSlots) =>
          oldSlots.filter((slot) => slot.dateStr !== dateStr)
        );

        return next;
      }

      return [...prev, dateStr].sort();
    });
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
  const selectAvailabilityByPeriod = (period, targetDateStr, targetVenue) => {
  if (!selectedStudent) return;

  const filtered = selectedAvailabilitySlots.filter((slot) => {
    if (slot.dateStr !== targetDateStr) return false;
    if (targetVenue && slot.venue !== targetVenue) return false;

    if (checkStudentAvailabilityDisabled(slot)) return false;

    const alreadySent = studentAvailable.some((item) => {
      return (
        item.studentId === selectedStudent.id &&
        item.dateStr === slot.dateStr &&
        item.venue === slot.venue &&
        item.timeStr === slot.timeStr
      );
    });

    if (alreadySent) return false;

    if (period === 'all') return true;
    if (period === 'morning') return slot.totalMinutes < 12 * 60;
    if (period === 'afternoon') {
      return slot.totalMinutes >= 12 * 60 && slot.totalMinutes < 18 * 60;
    }
    if (period === 'night') return slot.totalMinutes >= 18 * 60;

    return false;
  });

  setPendingAvailabilitySlots((prev) => {
    const others = prev.filter((slot) => {
      if (slot.dateStr !== targetDateStr) return true;
      if (targetVenue && slot.venue !== targetVenue) return true;
      return true;
    });

    const merged = [...others, ...filtered];
    const uniqueSlots = merged.filter((slot, index, self) =>
      index === self.findIndex((s) => isSameSlot(s, slot))
    );

    return uniqueSlots.sort((a, b) => {
      if (a.dateStr !== b.dateStr) return a.dateStr.localeCompare(b.dateStr);
      if (a.venue !== b.venue) return a.venue.localeCompare(b.venue, 'zh-Hant');
      return a.totalMinutes - b.totalMinutes;
    });
  });
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

  const filteredStudents = students.filter((student) => {
    if (studentVenueFilter === '全部') return true;
    return Array.isArray(student.venues) && student.venues.includes(studentVenueFilter);
  });

  const sortedStudents = [...filteredStudents].sort((a, b) =>
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
  const nextWeekStudentAvailable = studentAvailable
    .filter((item) => nextWeekDateStrs.includes(item.dateStr))
    .sort((a, b) => {
      if (a.dateStr !== b.dateStr) return a.dateStr.localeCompare(b.dateStr);
      if (a.totalMinutes !== b.totalMinutes) return a.totalMinutes - b.totalMinutes;
      if (a.venue !== b.venue) return a.venue.localeCompare(b.venue, 'zh-Hant');
      return (a.name || '').localeCompare(b.name || '', 'zh-Hant');
    });
  const adminDaySchedule = [
    ...adminSelectedDateBookings.map((item) => ({ ...item, typeLabel: '正式排課', kind: 'booking' })),
    ...adminSelectedDateUnavailable.map((item) => ({
      ...item,
      typeLabel: `教練不可：${item.type || '私事'}`,
      kind: 'unavailable'
    }))
  ].sort((a, b) => a.totalMinutes - b.totalMinutes);

  const getTimePeriodPreferenceScore = (candidate) => {
    const minutes = candidate.totalMinutes;
    let score = 0;

    // 規則 3：所有課都盡量 10:00 以後開始
    if (minutes < 9 * 60) {
      score += 90;        // 08:00～08:59 很不優先
    } else if (minutes < 10 * 60) {
      score += 45;        // 09:00～09:59 稍微不優先
    }

    // 規則 4：排課時間優先 下午 > 早上 > 晚上
    if (minutes >= 12 * 60 && minutes < 18 * 60) {
      score -= 45;        // 下午最優
    } else if (minutes >= 10 * 60 && minutes < 12 * 60) {
      score -= 10;        // 10:00～11:59 早上可接受
    } else if (minutes >= 18 * 60) {
      score += 35;        // 晚上最後
    }

    // 規則 8：超過 20:00 不禁止，但降低優先權
    if (minutes >= 20 * 60) {
      score += 25;
    }

    return score;
  };

  const scoreCandidate = (candidate, planned, options = {}) => {
    let score = 0;
    // 同一學生同一天多個可選時段時，偏好：下午 > 早上 > 晚上
    score += getTimePeriodPreferenceScore(candidate);
    // 如果學生填的可用時間數量剛好等於每週堂數，優先排
    if (options.exactAvailability) {
      score -= 100;
    }
    
    const dayBlocks = getClassLikeBlocks(
      studentBookings,
      coachUnavailable,
      planned,
      candidate.dateStr
    );
    // 每天第一個地點希望從離家最近的場館開始。
    // 如果 candidate 會成為當天第一堂，就依離家遠近加權。
    const blocksBeforeCandidate = [...dayBlocks].sort(
      (a, b) => a.totalMinutes - b.totalMinutes
    );

    const isCandidateFirstOfDay =
      blocksBeforeCandidate.length === 0 ||
      candidate.totalMinutes < blocksBeforeCandidate[0].totalMinutes;

    if (isCandidateFirstOfDay) {
      score += getHomeVenueRank(candidate.venue) * 10;
    }
    // 盡量不要一天跑三個場館，但不硬性禁止。
    // 如果第三個點是中間線上課，也可以排，只是分數會稍微變差。
    const blocksAfterCandidate = [
      ...dayBlocks,
      {
        ...candidate,
        kind: 'planned'
      }
    ].sort((a, b) => a.totalMinutes - b.totalMinutes);

    // 規則 5：線上課希望是當天第一堂或最後一堂；星期六線上課更希望是第一堂
    const candidateIndexAfter = blocksAfterCandidate.findIndex((block) => {
      return (
        block.studentId === candidate.studentId &&
        block.dateStr === candidate.dateStr &&
        block.timeStr === candidate.timeStr &&
        block.venue === candidate.venue
      );
    });

    const isFirstOfDayAfter = candidateIndexAfter === 0;
    const isLastOfDayAfter = candidateIndexAfter === blocksAfterCandidate.length - 1;

    const candidateDay = new Date(`${candidate.dateStr}T00:00:00`).getDay();

    if (candidate.venue === '線上') {
      if (candidateDay === 6) {
        // 星期六線上課希望排第一堂
        if (isFirstOfDayAfter) score -= 50;
        else score += 80;
      } else {
        // 平日線上課希望第一堂或最後一堂
        if (isFirstOfDayAfter || isLastOfDayAfter) score -= 35;
        else score += 55;
      }
    }

    // 規則 6：課程集中一點；同場館更希望連續
    const nearestSameVenueGap = dayBlocks
      .filter((block) => normalizeVenueForTravel(block.venue) === normalizeVenueForTravel(candidate.venue))
      .map((block) => {
        const blockEnd = block.totalMinutes + CLASS_DURATION;
        const candidateEnd = candidate.totalMinutes + CLASS_DURATION;

        if (candidate.totalMinutes >= blockEnd) return candidate.totalMinutes - blockEnd;
        if (block.totalMinutes >= candidateEnd) return block.totalMinutes - candidateEnd;
        return 0;
      })
      .sort((a, b) => a - b)[0];

    if (nearestSameVenueGap !== undefined) {
      if (nearestSameVenueGap === 0) score -= 70;       // 同場館連續最優
      else if (nearestSameVenueGap <= 30) score -= 45;
      else if (nearestSameVenueGap <= 60) score -= 20;
      else score += Math.min(80, Math.floor(nearestSameVenueGap / 30) * 8);
    }

    // 規則 7：連續四堂課需至少休息半小時，不含通勤時間
    if (!hasEnoughRestForFourClasses(blocksAfterCandidate)) {
      score += 300;
    }

    // 規則 8：如果當天有 20:00 後的課，16:00～17:00 希望至少休息 30 分鐘
    if (
      hasLateClassAfterEight(blocksAfterCandidate) &&
      !hasThirtyMinuteRestBetween16And17(blocksAfterCandidate)
    ) {
      score += 120;
    }

    const venuesBefore = getCountedVenuesWithOnlineEdgeRule(dayBlocks);
    const venuesAfter = getCountedVenuesWithOnlineEdgeRule(blocksAfterCandidate);

    const venuesBeforeCount = venuesBefore.length;
    const venuesAfterCount = venuesAfter.length;

    const restIsEnough = hasEnoughRestAfterCandidate(
      studentBookings,
      coachUnavailable,
      planned,
      candidate
    );

    if (venuesAfterCount > venuesBeforeCount) {
      if (venuesAfterCount >= 3) {
        score += restIsEnough ? 120 : 220;
      } else {
        score += 45;
      }
    }
    // 減少無謂空等：排完後當天總空檔越多，分數越差。
    // 但至少保留一段可休息時間，所以不是完全壓到最緊。
    const idleBefore = getIdleMinutesOfDay(dayBlocks);
    const idleAfter = getIdleMinutesOfDay(blocksAfterCandidate);
    const extraIdle = Math.max(0, idleAfter - idleBefore);

    if (extraIdle > IDEAL_REST_MINUTES) {
      score += Math.min(60, Math.floor(extraIdle / 30) * 8);
    }
    // 如果線上課卡在中間，但前後實體課是同一個場館，
    // 且當天仍有足夠休息時間，就不要懲罰太重。
    const candidateIndex = blocksAfterCandidate.findIndex((block) => {
      return (
        block.studentId === candidate.studentId &&
        block.dateStr === candidate.dateStr &&
        block.timeStr === candidate.timeStr &&
        block.venue === candidate.venue
      );
    });

    const prevBlock = blocksAfterCandidate[candidateIndex - 1];
    const nextBlock = blocksAfterCandidate[candidateIndex + 1];

    const isOnlineBetweenSameVenue =
      candidate.venue === '線上' &&
      prevBlock &&
      nextBlock &&
      prevBlock.venue !== '線上' &&
      nextBlock.venue !== '線上' &&
      normalizeVenueForTravel(prevBlock.venue) === normalizeVenueForTravel(nextBlock.venue);

    if (isOnlineBetweenSameVenue && restIsEnough) {
      score -= 25;
    }
    // 與既有或已規劃課程衝突則不可排。
    const conflict = dayBlocks.some((block) => hasScheduleConflict(candidate, block));
    if (conflict) return Infinity;

    const workload = countWorkloadBlocks(studentBookings, coachUnavailable, planned, candidate.dateStr);
    if (workload >= MAX_CLASSES_PER_DAY) return Infinity;
    score += workload * 3;
    // 如果當天已經有課，盡量把課排近一點，避免中間空等太久。
    const nearestGap = dayBlocks
      .filter((block) => block.kind !== 'private')
      .map((block) => {
        const blockEnd = block.totalMinutes + CLASS_DURATION;
        const candidateEnd = candidate.totalMinutes + CLASS_DURATION;

        if (candidate.totalMinutes >= blockEnd) {
          return candidate.totalMinutes - blockEnd;
        }

        if (block.totalMinutes >= candidateEnd) {
          return block.totalMinutes - candidateEnd;
        }

        return 0;
      })
      .filter((gap) => gap >= 0)
      .sort((a, b) => a - b)[0];

    if (nearestGap !== undefined) {
      if (nearestGap === 0) score -= 35;          // 連在一起最優先
      else if (nearestGap <= 30) score -= 25;     // 中間只空 30 分鐘也很好
      else if (nearestGap <= 60) score -= 10;     // 空 1 小時可以接受
      else score += Math.min(80, Math.floor(nearestGap / 30) * 10); // 空太久變差
    }
    // 同場館、鄰近時間排一起更友善。
    const sameVenueNear = dayBlocks.some((block) => {
    const sameVenue =
      normalizeVenueForTravel(block.venue) === normalizeVenueForTravel(candidate.venue);
    const diff = Math.abs(block.totalMinutes - candidate.totalMinutes);

    return sameVenue && diff >= CLASS_DURATION && diff <= 120;
  });

  if (sameVenueNear) score -= 30;

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
    const restAfter = analyzeRest(
      studentBookings,
      coachUnavailable,
      [...planned, candidate],
      candidate.dateStr
    );

    if ((restAfter.maxConsecutiveClasses || 0) >= REST_AFTER_CLASS_HOURS) {
      if (restAfter.maxGap >= IDEAL_REST_MINUTES) score -= 12;
      else if (restAfter.maxGap >= MIN_REST_MINUTES) score += 35;
      else score += 120;
    }

    return score;
  };

  const generateWizardPlan = () => {
    setWizardPlan([]);
    setWizardUnscheduled([]);
    setWizardGeneratedAt('');

    // 以「目前使用時間」的下週作為排課週
    const targetNextWeekDateStrs = getNextWeekDaysFromCurrentMonday(currentNow).map(formatLocalDate);

    console.log('currentNow:', formatDisplayDateTime(currentNow));
    console.log('targetNextWeekDateStrs:', targetNextWeekDateStrs);

    console.log('studentAvailable count:', studentAvailable.length);

    console.table(studentAvailable.map(x => ({
      id: x.id,
      studentId: x.studentId,
      name: x.name,
      dateStr: x.dateStr,
      timeStr: x.timeStr,
      venue: x.venue,
      status: x.status
    })));

    const weekAvail = studentAvailable.filter((item) =>
      targetNextWeekDateStrs.includes(item.dateStr)
    );

    console.log('matched weekAvail:', weekAvail.map(x => ({
      id: x.id,
      studentId: x.studentId,
      name: x.name,
      dateStr: x.dateStr,
      timeStr: x.timeStr,
      venue: x.venue
    })));

    if (weekAvail.length === 0) {
      alert(
        `找不到「目前使用時間的下週」學生可用時間。\n\n` +
        `目前使用時間：${formatDisplayDateTime(currentNow)}\n` +
        `系統正在尋找：${targetNextWeekDateStrs[0]} ～ ${targetNextWeekDateStrs[targetNextWeekDateStrs.length - 1]}\n\n` +
        `請確認學生可用時間是否填在這一週。`
      );
      return;
    }

    const planned = [];
    const unscheduled = [];

    // 只排「下週有填可用時間」的學生
    const studentsByNeed = [...students].sort((a, b) => {
      const aNeeded = getStudentWeeklyLessons(a); // A
      const bNeeded = getStudentWeeklyLessons(b);

      const aAvailableCount = weekAvail.filter((x) => x.studentId === a.id).length; // B
      const bAvailableCount = weekAvail.filter((x) => x.studentId === b.id).length;

      // 規則 2：B - A 越小越先排，暫不考慮負數情況
      const aDiff = aAvailableCount === 0 ? Infinity : Math.max(0, aAvailableCount - aNeeded);
      const bDiff = bAvailableCount === 0 ? Infinity : Math.max(0, bAvailableCount - bNeeded);

      if (aDiff !== bDiff) return aDiff - bDiff;

      // 若 B-A 一樣，可用時段少的先排
      if (aAvailableCount !== bAvailableCount) {
        return aAvailableCount - bAvailableCount;
      }

      return (a.name || '').localeCompare(b.name || '', 'zh-Hant');
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

      const exactAvailability = candidates.length === needed;
      let scheduledCount = 0;

      if (candidates.length === 0) {
        unscheduled.push({
          studentId: student.id,
          name: student.name,
          reason: `下週沒有填可用時間，但每週需要 ${needed} 堂`
        });
        continue;
      }

      for (let lesson = 0; lesson < needed; lesson++) {
        let best = null;
        let bestScore = Infinity;

        for (const candidate of candidates) {
          const alreadyChosen = planned.some((p) => {
            return (
              p.studentId === candidate.studentId &&
              p.dateStr === candidate.dateStr &&
              p.timeStr === candidate.timeStr &&
              p.venue === candidate.venue
            );
          });

          if (alreadyChosen) continue;

          const score = scoreCandidate(candidate, planned, {
            exactAvailability
          });

          if (score < bestScore) {
            bestScore = score;
            best = candidate;
          }
        }

        if (best && bestScore < Infinity) {
          planned.push({ ...best, score: bestScore });
          scheduledCount += 1;
        } else {
          unscheduled.push({
            studentId: student.id,
            name: student.name,
            reason:
              candidates.length < needed
                ? `下週只填了 ${candidates.length} 個可用時間，但每週需要 ${needed} 堂`
                : `下週第 ${lesson + 1} 堂因時間、交通、場館或休息限制無法安排`
          });
        }
      }

      // 如果這位學生有填時間，但完全沒排到，清楚列出
      if (scheduledCount === 0 && candidates.length > 0) {
        const alreadyListed = unscheduled.some(
          (item) => item.studentId === student.id
        );

        if (!alreadyListed) {
          unscheduled.push({
            studentId: student.id,
            name: student.name,
            reason:
              '下週有填可用時間，但全部都因時間、交通、場館或休息限制無法安排'
          });
        }
      }
    }

    planned.sort((a, b) => {
      if (a.dateStr !== b.dateStr) return a.dateStr.localeCompare(b.dateStr);
      if (a.totalMinutes !== b.totalMinutes) {
        return a.totalMinutes - b.totalMinutes;
      }
      return a.venue.localeCompare(b.venue, 'zh-Hant');
    });

    setWizardPlan(planned);
    setWizardUnscheduled(unscheduled);
    setWizardGeneratedAt(formatDisplayDateTime(currentNow));
  };
  const clearWizardPlan = () => {
    setWizardPlan([]);
    setWizardUnscheduled([]);
    setWizardGeneratedAt('');
  };
  const handleDropWizardItem = (targetDateStr, targetTimeStr) => {
  if (!draggingWizardItem) return;

  const oldItem = draggingWizardItem;
  const newTimeStr = targetTimeStr;
  const newDateTime = createDateTime(targetDateStr, newTimeStr);
  const newTotalMinutes = getTotalMinutes(newDateTime);

  const movedItem = {
    ...oldItem,
    dateStr: targetDateStr,
    timeStr: newTimeStr,
    totalMinutes: newTotalMinutes,
    jsDate: newDateTime
  };

  // 重要：先把原本那堂課從 wizardPlan 移除。
  // 這樣 A 從 09:00 移到 09:30 後，再移回 09:00 時，
  // 不會被自己的原時段誤判為衝突。
  const otherPlans = wizardPlan.filter((item) => {
    const itemKey = `${item.studentId}-${item.dateStr}-${item.timeStr}-${item.venue}`;
    return itemKey !== oldItem._dragKey;
  });

  const isManualItem = oldItem.source === 'manual';

  if (!isManualItem) {
    const studentCanTakeThisSlot = studentAvailable.some((item) => {
      return (
        item.studentId === oldItem.studentId &&
        item.dateStr === targetDateStr &&
        item.venue === oldItem.venue &&
        item.timeStr === newTimeStr
      );
    });

    if (!studentCanTakeThisSlot) {
      const confirmOverride = window.confirm(
        `${oldItem.name} 沒有選擇 ${targetDateStr} ${newTimeStr} ${oldItem.venue}。\n\n仍然要將課程改到這個時間嗎？`
      );

      if (!confirmOverride) {
        setDraggingWizardItem(null);
        return;
      }
    }
  }

  const conflict = otherPlans.some((item) => {
    return hasScheduleConflict(movedItem, {
      ...item,
      kind: 'planned'
    });
  });

  if (conflict) {
    alert('這個時間會和其他已排課程或交通時間衝突，已移回原本位置');
    setDraggingWizardItem(null);
    return;
  }

  setWizardPlan(
    [...otherPlans, movedItem].sort((a, b) => {
      if (a.dateStr !== b.dateStr) return a.dateStr.localeCompare(b.dateStr);
      if (a.totalMinutes !== b.totalMinutes) return a.totalMinutes - b.totalMinutes;
      return a.venue.localeCompare(b.venue, 'zh-Hant');
    })
  );

  setDraggingWizardItem(null);
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
            source: item.source || 'wizard'
          });
        });
      });

      alert('已採用排課小精靈建議');
    } catch (error) {
      alert(error.message);
    }
  };
  const wizardTimeRows = useMemo(() => {
    const rows = [];

    for (let hour = 8; hour <= 21; hour++) {
      rows.push({
        timeStr: toTimeStr(hour, 0),
        totalMinutes: hour * 60
      });

      rows.push({
        timeStr: toTimeStr(hour, 30),
        totalMinutes: hour * 60 + 30
      });
    }

    return rows;
  }, []);

  const openWizardContextMenu = (event, dateStr, timeStr) => {
    event.preventDefault();

    setWizardContextMenu({
      x: event.clientX,
      y: event.clientY,
      dateStr,
      timeStr
    });

    setManualWizardStudentId('');
    setManualWizardVenue('中山');
  };

  const addManualWizardItem = () => {
    if (!wizardContextMenu) return;

    const student = students.find((s) => s.id === manualWizardStudentId);
    if (!student) {
      alert('請選擇學生');
      return;
    }

    if (!manualWizardVenue) {
      alert('請選擇場館');
      return;
    }

    const dateStr = wizardContextMenu.dateStr;
    const timeStr = wizardContextMenu.timeStr;
    const jsDate = createDateTime(dateStr, timeStr);
    const totalMinutes = getTotalMinutes(jsDate);

    const manualItem = {
      id: `manual-${student.id}-${dateStr}-${timeStr}-${manualWizardVenue}-${Date.now()}`,
      studentId: student.id,
      name: student.name,
      dateStr,
      timeStr,
      venue: manualWizardVenue,
      totalMinutes,
      jsDate,
      kind: 'planned',
      source: 'manual',
      score: 999
    };

    const conflict = wizardPlan.some((item) =>
      hasScheduleConflict(manualItem, {
        ...item,
        kind: 'planned'
      })
    );

    if (conflict) {
      const confirmAdd = window.confirm(
        '這個時間可能和目前建議課表中的其他課程或交通時間衝突，仍然要加入嗎？'
      );

      if (!confirmAdd) return;
    }

    setWizardPlan((prev) =>
      [...prev, manualItem].sort((a, b) => {
        if (a.dateStr !== b.dateStr) return a.dateStr.localeCompare(b.dateStr);
        if (a.totalMinutes !== b.totalMinutes) return a.totalMinutes - b.totalMinutes;
        return a.venue.localeCompare(b.venue, 'zh-Hant');
      })
    );

    setWizardContextMenu(null);
  };

  const getWizardCellItems = (dateStr, rowTotalMinutes) => {
    return wizardPlan.filter((item) => {
      return item.dateStr === dateStr && item.totalMinutes === rowTotalMinutes;
    });
  };

  const openAvailabilityPopover = (event, item) => {
    const availableSlots = studentAvailable
      .filter((slot) => {
        return (
          slot.studentId === item.studentId &&
          nextWeekDateStrs.includes(slot.dateStr)
        );
      })
      .sort((a, b) => {
        if (a.dateStr !== b.dateStr) return a.dateStr.localeCompare(b.dateStr);
        if (a.totalMinutes !== b.totalMinutes) return a.totalMinutes - b.totalMinutes;
        if (a.venue !== b.venue) return a.venue.localeCompare(b.venue, 'zh-Hant');
        return 0;
      });

    setAvailabilityPopover({
      x: event.clientX + 12,
      y: event.clientY + 12,
      studentId: item.studentId,
      name: item.name,
      slots: availableSlots
    });
  };

  const wizardRestByDay = nextWeekDateStrs.map((dateStr) => ({
    dateStr,
    ...analyzeRest(studentBookings, coachUnavailable, wizardPlan, dateStr)
  }));
  const wizardUnselected = useMemo(() => {
    const selectedStudentIds = new Set(
      studentAvailable
        .filter((item) => nextWeekDateStrs.includes(item.dateStr))
        .map((item) => item.studentId)
    );

    return students
      .filter((student) => !selectedStudentIds.has(student.id))
      .sort((a, b) => (a.name || '').localeCompare(b.name || '', 'zh-Hant'));
  }, [students, studentAvailable, nextWeekDateStrs]);

  const manualWizardStudents = useMemo(() => {
    const ids = new Set();

    wizardUnscheduled.forEach((item) => {
      if (item.studentId) ids.add(item.studentId);
    });

    wizardUnselected.forEach((student) => {
      if (student.id) ids.add(student.id);
    });

    return students
      .filter((student) => ids.has(student.id))
      .sort((a, b) => (a.name || '').localeCompare(b.name || '', 'zh-Hant'));
  }, [students, wizardUnscheduled, wizardUnselected]);

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
      {availabilityPopover && (
        <div
          className="fixed z-50 bg-white border rounded shadow-lg p-3 w-72 text-sm"
          style={{
            top: availabilityPopover.y,
            left: availabilityPopover.x
          }}
          onMouseLeave={() => setAvailabilityPopover(null)}
        >
          <div className="font-bold mb-2">
            {availabilityPopover.name} 已選可上課時段
          </div>

          {availabilityPopover.slots.length === 0 ? (
            <div className="text-gray-400 text-xs">
              這位學生下週沒有送出可上課時間。
            </div>
          ) : (
            <div className="space-y-1 max-h-60 overflow-auto">
              {availabilityPopover.slots.map((slot) => (
                <div
                  key={`${slot.id}-${slot.dateStr}-${slot.timeStr}-${slot.venue}`}
                  className="border rounded px-2 py-1"
                  style={{
                    borderLeft: '4px solid #0ABAB5'
                  }}
                >
                  <div className="font-medium">
                    {slot.dateStr}｜{getWeekdayLabel(slot.dateStr)}
                  </div>
                  <div className="text-gray-600 text-xs">
                    {slot.timeStr}｜{slot.venue}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {wizardContextMenu && (
        <div
          className="fixed z-50 bg-white border rounded shadow-lg p-3 w-64"
          style={{
            top: wizardContextMenu.y,
            left: wizardContextMenu.x
          }}
        >
          <div className="font-bold text-sm mb-2">
            新增到建議課表
          </div>

          <div className="text-xs text-gray-500 mb-2">
            {wizardContextMenu.dateStr}｜{wizardContextMenu.timeStr}
          </div>

          <label className="block text-xs mb-1">學生</label>
          <select
            value={manualWizardStudentId}
            onChange={(e) => setManualWizardStudentId(e.target.value)}
            className="w-full p-2 border rounded mb-2 text-sm"
          >
            <option value="">請選擇學生</option>
            {manualWizardStudents.map((student) => (
              <option key={student.id} value={student.id}>
                {student.name || '未命名學生'}
              </option>
            ))}
          </select>

          <label className="block text-xs mb-1">場館</label>
          <select
            value={manualWizardVenue}
            onChange={(e) => setManualWizardVenue(e.target.value)}
            className="w-full p-2 border rounded mb-3 text-sm"
          >
            {venues.map((venue) => (
              <option key={venue} value={venue}>
                {venue}
              </option>
            ))}
          </select>

          <button
            onClick={addManualWizardItem}
            className="w-full py-2 rounded bg-indigo-600 text-white text-sm"
          >
            加入
          </button>

          <button
            onClick={() => setWizardContextMenu(null)}
            className="w-full py-2 rounded bg-gray-100 text-sm mt-2"
          >
            取消
          </button>
        </div>
      )}
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
              {nextWeekDays.map((day) => {
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
                    <div className="text-[10px]">
                      {getWeekdayLabel(dateStr)}
                    </div>
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
              <div className="flex items-center justify-between gap-2 mb-2">
                <h2 className="font-bold">
                  {group.dateStr}｜{getWeekdayLabel(group.dateStr)}｜{group.venue}
                </h2>

                <div className="flex gap-1">
                  <button
                    onClick={() => selectAvailabilityByPeriod('all', group.dateStr, group.venue)}
                    className="px-2 py-1 rounded bg-gray-100 text-xs"
                  >
                    全天
                  </button>

                  <button
                    onClick={() => selectAvailabilityByPeriod('morning', group.dateStr, group.venue)}
                    className="px-2 py-1 rounded bg-gray-100 text-xs"
                  >
                    上午
                  </button>

                  <button
                    onClick={() => selectAvailabilityByPeriod('afternoon', group.dateStr, group.venue)}
                    className="px-2 py-1 rounded bg-gray-100 text-xs"
                  >
                    下午
                  </button>

                  <button
                    onClick={() => selectAvailabilityByPeriod('night', group.dateStr, group.venue)}
                    className="px-2 py-1 rounded bg-gray-100 text-xs"
                  >
                    晚上
                  </button>
                </div>
              </div>

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
          {authLoading ? (
            <p className="text-center text-gray-400">
              確認登入狀態中...
            </p>
          ) : !adminUser ? (
            <div className="max-w-md mx-auto border rounded p-5 bg-white">
              <h2 className="font-bold text-lg mb-4 text-center">教練後台登入</h2>

              <label className="block text-sm mb-1">Email</label>
              <input
                type="email"
                value={adminEmail}
                onChange={(e) => setAdminEmail(e.target.value)}
                className="w-full p-2 border rounded mb-3"
                placeholder="請輸入教練 Email"
                autoComplete="email"
              />

              <label className="block text-sm mb-1">密碼</label>
              <input
                type="password"
                value={adminPassword}
                onChange={(e) => setAdminPassword(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleAdminLogin();
                }}
                className="w-full p-2 border rounded mb-4"
                placeholder="請輸入密碼"
                autoComplete="current-password"
              />

              <button
                onClick={handleAdminLogin}
                className="w-full py-2 rounded bg-indigo-600 text-white"
              >
                登入
              </button>
            </div>
          ) : (
            <>
              <div className="max-w-md mx-auto mb-4 flex justify-between items-center text-sm">
                <div className="text-gray-600">
                  已登入：{adminUser.email}
                </div>

                <button
                  onClick={handleAdminLogout}
                  className="px-3 py-1 rounded bg-gray-100"
                >
                  登出
                </button>
              </div>
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
          <div className="max-w-md mx-auto border rounded p-3 mb-4 bg-gray-50">
            <label className="block text-sm mb-1">系統目前時間</label>

            <input
              type="datetime-local"
              value={manualNow}
              onChange={(e) => setManualNow(e.target.value)}
              className="w-full p-2 border rounded mb-2"
            />
            <div className="text-xs text-gray-600 mb-2">
              目前使用時間：{formatDisplayDateTime(currentNow)}
            </div>
            <div className="text-xs text-gray-500 mb-2">
              空白時會自動讀取現在時間；填寫後會用此時間判斷本週、下週、截止與過期日期。
            </div>

            <button
              onClick={() => {
                setManualNow('');
                setAutoNow(new Date());
              }}
              className="w-full py-2 rounded bg-gray-100 text-sm"
            >
              改回自動讀取現在時間
            </button>
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
          {adminTab === 'students' && (
            <div className="max-w-md mx-auto">
              <h2 className="font-bold mb-3">新增學生</h2>

              <div className="border rounded p-4 bg-gray-50 mb-5">
                <label className="block text-sm mb-1">學生姓名</label>
                <input
                  value={newStudentName}
                  onChange={(e) => setNewStudentName(e.target.value)}
                  className="w-full p-2 border rounded mb-3"
                  placeholder="請輸入學生姓名"
                />

                <label className="block text-sm mb-1">價格</label>
                <input
                  value={newStudentPrice}
                  onChange={(e) => setNewStudentPrice(e.target.value)}
                  className="w-full p-2 border rounded mb-3"
                  placeholder="可先空白"
                />

                <label className="block text-sm mb-1">每週堂數</label>
                <input
                  type="number"
                  min="1"
                  value={newStudentWeeklyLessons}
                  onChange={(e) => setNewStudentWeeklyLessons(e.target.value)}
                  className="w-full p-2 border rounded mb-3"
                />

                <div className="text-sm mb-2">上課場館</div>

                <div className="grid grid-cols-2 gap-2 mb-3">
                  {venues.map((venue) => (
                    <label
                      key={venue}
                      className="flex items-center gap-2 text-sm border rounded p-2"
                    >
                      <input
                        type="checkbox"
                        checked={newStudentVenues.includes(venue)}
                        onChange={() => handleToggleNewStudentVenue(venue)}
                      />
                      {venue}
                    </label>
                  ))}
                </div>

                <button
                  onClick={handleAddStudent}
                  className="w-full py-2 rounded bg-indigo-600 text-white"
                >
                  新增學生
                </button>
              </div>

              <h2 className="font-bold mb-3">學生管理</h2>
              <div className="mb-3">
                <label className="block text-sm mb-1">依場館篩選</label>
                <select
                  value={studentVenueFilter}
                  onChange={(e) => {
                    setStudentVenueFilter(e.target.value);
                    setStudentPage(1);
                  }}
                  className="w-full p-2 border rounded"
                >
                  <option value="全部">全部</option>
                  {venues.map((venue) => (
                    <option key={venue} value={venue}>
                      {venue}
                    </option>
                  ))}
                </select>
              </div>
              <div className="text-sm text-gray-500 mb-3">
                第 {studentPage} / {totalStudentPages} 頁，每頁 10 位學生
              </div>

              <div className="space-y-3">
                {currentStudents.length === 0 && (
                  <p className="text-sm text-gray-400">目前沒有學生資料</p>
                )}

                {currentStudents.map((student) => (
                  <div key={student.id} className="border rounded p-3">
                    <div className="font-bold mb-1">
                      {student.name || '未命名學生'}
                    </div>

                    <div className="text-sm text-gray-500 mb-2">
                      價格：{student.price || ''}
                    </div>

                    <label className="block text-sm mb-1">每週堂數</label>
                    <input
                      type="number"
                      min="1"
                      defaultValue={getStudentWeeklyLessons(student)}
                      onBlur={(e) =>
                        updateStudentWeeklyLessons(student, e.target.value)
                      }
                      className="w-full p-2 border rounded mb-2"
                    />

                    <div className="text-sm mb-2">
                      上課場館：
                      {student.venues && student.venues.length > 0
                        ? student.venues.join('、')
                        : '尚未設定'}
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                      {venues.map((venue) => (
                        <label
                          key={venue}
                          className="flex items-center gap-2 text-sm border rounded p-2"
                        >
                          <input
                            type="checkbox"
                            checked={
                              Array.isArray(student.venues) &&
                              student.venues.includes(venue)
                            }
                            onChange={() => handleToggleStudentVenue(student, venue)}
                          />
                          {venue}
                        </label>
                      ))}
                    </div>
                  </div>
                ))}
              </div>

              <div className="flex gap-2 mt-4">
                <button
                  disabled={studentPage <= 1}
                  onClick={() => setStudentPage((p) => Math.max(1, p - 1))}
                  className={`flex-1 py-2 rounded ${
                    studentPage <= 1
                      ? 'bg-gray-100 text-gray-300'
                      : 'bg-gray-100'
                  }`}
                >
                  上一頁
                </button>

                <button
                  disabled={studentPage >= totalStudentPages}
                  onClick={() =>
                    setStudentPage((p) => Math.min(totalStudentPages, p + 1))
                  }
                  className={`flex-1 py-2 rounded ${
                    studentPage >= totalStudentPages
                      ? 'bg-gray-100 text-gray-300'
                      : 'bg-gray-100'
                  }`}
                >
                  下一頁
                </button>
              </div>
            </div>
          )}
          {adminTab === 'availability' && (
            <div className="max-w-md mx-auto">
              <h2 className="font-bold mb-3">新增教練不可預約時間</h2>

              <div className="border rounded p-4 bg-gray-50 mb-5">
                <label className="block text-sm mb-1">日期</label>
                <input
                  type="date"
                  value={adminDate}
                  onChange={(e) => setAdminDate(e.target.value)}
                  className="w-full p-2 border rounded mb-3"
                />

                <label className="block text-sm mb-1">時間</label>
                <input
                  type="time"
                  value={adminTime}
                  onChange={(e) => setAdminTime(e.target.value)}
                  step="1800"
                  className="w-full p-2 border rounded mb-3"
                />

                <label className="block text-sm mb-1">場地</label>
                <select
                  value={adminVenue}
                  onChange={(e) => setAdminVenue(e.target.value)}
                  className="w-full p-2 border rounded mb-3"
                >
                  {venues.map((venue) => (
                    <option key={venue} value={venue}>
                      {venue}
                    </option>
                  ))}
                </select>

                <label className="block text-sm mb-1">類型</label>
                <select
                  value={adminUnavailableType}
                  onChange={(e) => setAdminUnavailableType(e.target.value)}
                  className="w-full p-2 border rounded mb-3"
                >
                  {unavailableTypes.map((type) => (
                    <option key={type} value={type}>
                      {type}
                    </option>
                  ))}
                </select>

                <p className="text-xs text-gray-500 mb-3">
                  私事只會擋住不可預約時間；教學、工作、其他會算進一天 8 堂工作量。
                </p>

                <button
                  onClick={handleAddCoachUnavailable}
                  className="w-full py-2 rounded bg-indigo-600 text-white"
                >
                  新增不可預約
                </button>
              </div>

              {editingUnavailableId && (
                <div className="border rounded p-4 bg-gray-50 mb-5">
                  <h3 className="font-bold mb-3">編輯不可預約時間</h3>

                  <label className="block text-sm mb-1">日期</label>
                  <input
                    type="date"
                    value={editingDate}
                    onChange={(e) => setEditingDate(e.target.value)}
                    className="w-full p-2 border rounded mb-3"
                  />

                  <label className="block text-sm mb-1">時間</label>
                  <input
                    type="time"
                    value={editingTime}
                    onChange={(e) => setEditingTime(e.target.value)}
                    step="1800"
                    className="w-full p-2 border rounded mb-3"
                  />

                  <label className="block text-sm mb-1">場地</label>
                  <select
                    value={editingVenue}
                    onChange={(e) => setEditingVenue(e.target.value)}
                    className="w-full p-2 border rounded mb-3"
                  >
                    {venues.map((venue) => (
                      <option key={venue} value={venue}>
                        {venue}
                      </option>
                    ))}
                  </select>

                  <label className="block text-sm mb-1">類型</label>
                  <select
                    value={editingType}
                    onChange={(e) => setEditingType(e.target.value)}
                    className="w-full p-2 border rounded mb-3"
                  >
                    {unavailableTypes.map((type) => (
                      <option key={type} value={type}>
                        {type}
                      </option>
                    ))}
                  </select>

                  <button
                    onClick={handleUpdateUnavailable}
                    className="w-full py-2 rounded bg-indigo-600 text-white"
                  >
                    儲存修改
                  </button>

                  <button
                    onClick={() => setEditingUnavailableId('')}
                    className="w-full py-2 rounded bg-gray-100 mt-2"
                  >
                    取消編輯
                  </button>
                </div>
              )}
              <h2 className="font-bold mb-3">學生已選下週可上課時間</h2>

              <p className="text-xs text-gray-500 mb-2">
                目前使用時間：{formatDisplayDateTime(currentNow)}。
                顯示區間：{nextWeekDateStrs[0]} ～ {nextWeekDateStrs[nextWeekDateStrs.length - 1]}
              </p>

              <div className="space-y-2 mb-5">
                {nextWeekStudentAvailable.length === 0 && (
                  <p className="text-sm text-gray-400">
                    目前使用時間的下週沒有學生送出的可上課時間
                  </p>
                )}

                {nextWeekStudentAvailable.map((item) => (
                  <div
                    key={item.id}
                    className="border rounded p-3 bg-white"
                  >
                    <div className="font-medium">
                      {item.dateStr}｜{getWeekdayLabel(item.dateStr)}｜{item.venue}｜{item.timeStr}
                    </div>

                    <div className="text-sm text-gray-500">
                      學生：{item.name || '未填姓名'}
                    </div>
                  </div>
                ))}
              </div>
              <h2 className="font-bold mb-3">未來兩週教練不能的時間</h2>

              <div className="space-y-2">
                {nextTwoWeekUnavailable.length === 0 && (
                  <p className="text-sm text-gray-400">
                    未來兩週沒有設定教練不可預約時間
                  </p>
                )}

                {nextTwoWeekUnavailable.map((item) => (
                  <div
                    key={item.id}
                    className="border rounded p-3 flex justify-between items-center"
                  >
                    <div>
                      <div className="font-medium">
                        {item.dateStr}｜{item.venue}｜{item.timeStr}
                      </div>

                      <div className="text-sm text-gray-500">
                        類型：{item.type || '私事'}
                      </div>
                    </div>

                    <div className="flex gap-2">
                      <button
                        onClick={() => startEditUnavailable(item)}
                        className="text-sm px-3 py-1 rounded bg-gray-100"
                      >
                        編輯
                      </button>

                      <button
                        onClick={() => handleDeleteUnavailable(item)}
                        className="text-sm px-3 py-1 rounded bg-red-100 text-red-600"
                      >
                        刪除
                      </button>
                    </div>
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
                    目前系統時間判定的下週為：
                    {nextWeekDateStrs[0]}～{nextWeekDateStrs[nextWeekDateStrs.length - 1]}。
                    排課小精靈會產生這一週的建議課表。
                  </p>
                </div>

                <button
                  onClick={handleSaveWizardCutoff}
                  className="w-full py-2 rounded bg-gray-100 mb-3"
                >
                  儲存截止時間
                </button>
                <p className="text-xs text-gray-500 mt-2">
                  目前使用時間：{formatDisplayDateTime(currentNow)}。系統將產生
                  {nextWeekDateStrs[0]} ～ {nextWeekDateStrs[nextWeekDateStrs.length - 1]}
                  的排課建議。
                </p>

                <button
                  onClick={generateWizardPlan}
                  className="w-full py-2 rounded bg-indigo-600 text-white mt-3"
                >
                  重新產生下週排課建議
                </button>

                <button
                  onClick={adoptWizardPlan}
                  className="w-full py-2 rounded bg-green-600 text-white mt-2"
                >
                  採用建議並寫入正式排課
                </button>
                <button
                  onClick={clearWizardPlan}
                  className="w-full py-2 rounded bg-red-50 text-red-600 mt-2"
                >
                  清空目前排課
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
              {wizardGeneratedAt && (
                <div className="mb-3 text-sm text-gray-600 text-center">
                  排課建議產生時間：{wizardGeneratedAt}
                </div>
              )}
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
                    {wizardTimeRows.map((row) => (
                      <tr key={row.timeStr} className="h-10">
                        <td className="border-t border-r p-0 font-medium text-xs relative w-16 bg-white">
                          <span className="absolute -top-2 left-1 bg-white px-1 text-gray-600">
                            {row.timeStr}
                          </span>
                        </td>

                        {nextWeekDateStrs.map((dateStr) => {
                          const items = getWizardCellItems(dateStr, row.totalMinutes);

                          const isCoveredByPreviousClass = wizardPlan.some((item) => {
                            return (
                              item.dateStr === dateStr &&
                              item.totalMinutes < row.totalMinutes &&
                              item.totalMinutes + CLASS_DURATION > row.totalMinutes
                            );
                          });

                          if (isCoveredByPreviousClass) {
                            return null;
                          }

                          return (
                            <td
                              key={`${dateStr}-${row.timeStr}`}
                              onContextMenu={(e) => openWizardContextMenu(e, dateStr, row.timeStr)}
                              rowSpan={items.length > 0 ? 2 : 1}
                              className="border-t border-r p-1 align-top h-10"
                              onDragOver={(e) => e.preventDefault()}
                              onDrop={() => handleDropWizardItem(dateStr, row.timeStr)}
                            >
                              {items.map((item) => (
                                <div
                                  key={`${item.studentId}-${item.dateStr}-${item.timeStr}-${item.venue}`}
                                  draggable
                                  onMouseEnter={(e) => openAvailabilityPopover(e, item)}
                                  onDragStart={() =>
                                    setDraggingWizardItem({
                                      ...item,
                                      _dragKey: `${item.studentId}-${item.dateStr}-${item.timeStr}-${item.venue}`
                                    })
                                  }
                                  onDragEnd={() => setDraggingWizardItem(null)}
                                  className="rounded bg-indigo-50 border border-indigo-100 p-2 cursor-move min-h-[72px]"
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
                    ))}
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

  <div className="mt-5">
    <h2 className="font-bold mb-2">未選課</h2>

    <div className="space-y-2">
      {wizardUnselected.length === 0 && (
        <p className="text-sm text-gray-400">
          目前所有學生都已填寫下週可上課時間
        </p>
      )}

      {wizardUnselected.map((student) => (
        <div
          key={student.id}
          className="border rounded p-3 bg-gray-50"
        >
          <div className="font-medium">
            {student.name || '未命名學生'}
          </div>

          <div className="text-sm text-gray-500">
            上課場館：
            {student.venues && student.venues.length > 0
              ? student.venues.join('、')
              : '尚未設定'}
          </div>

          <div className="text-sm text-gray-500">
            每週堂數：{getStudentWeeklyLessons(student)}
          </div>
        </div>
      ))}
    </div>
  </div>
</div>
                
              </div>
            </div>
          )}
        </>
          )}
        </>
      )}
    </div>
  );
};

export default App;
