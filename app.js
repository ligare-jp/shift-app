// ==============================================================
// シフト管理アプリ ロジック
// Firebase Firestore を使い、複数端末からデータを共有します。
// ==============================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth,
  signInAnonymously,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore,
  collection,
  doc,
  setDoc,
  deleteDoc,
  addDoc,
  onSnapshot,
  query,
  where,
  writeBatch
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

import { firebaseConfig, ADMIN_PIN } from "./firebase-config.js";

// --------------------------------------------------------------
// 初期設定チェック(まだ firebase-config.js を書き換えていない場合)
// --------------------------------------------------------------
const isConfigured = firebaseConfig.apiKey && !firebaseConfig.apiKey.startsWith("YOUR_");

if (!isConfigured) {
  document.querySelector("main").innerHTML = `
    <div class="setup-warning">
      <strong>初期設定が必要です。</strong><br>
      firebase-config.js の中身を、あなた自身の Firebase プロジェクトの設定値に
      書き換えてから、もう一度このページを開いてください。手順は README.md を
      ご覧ください。
    </div>`;
  throw new Error("firebase-config.js が未設定です");
}

// --------------------------------------------------------------
// Firebase 初期化
// --------------------------------------------------------------
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const staffCol = collection(db, "staff");
const entriesCol = collection(db, "shiftEntries");

// --------------------------------------------------------------
// 状態
// --------------------------------------------------------------
const today = new Date();
let currentYear = today.getFullYear();
let currentMonth = today.getMonth(); // 0-11

let staffList = [];              // [{id, name}]
let monthEntries = [];           // このstate月のシフトエントリ一覧
let unsubEntries = null;

let selectedStaffId = localStorage.getItem("shiftapp_staffId") || "";
let isAdminUnlocked = sessionStorage.getItem("shiftapp_admin") === "1";

const DOW = ["日", "月", "火", "水", "木", "金", "土"];

// --------------------------------------------------------------
// DOM 参照
// --------------------------------------------------------------
const tabsNav = document.getElementById("tabs");
const staffSelect = document.getElementById("staffSelect");

const monthLabelStaff = document.getElementById("monthLabelStaff");
const monthLabelAdmin = document.getElementById("monthLabelAdmin");
const calendarStaff = document.getElementById("calendarStaff");
const calendarAdmin = document.getElementById("calendarAdmin");

const addStaffForm = document.getElementById("addStaffForm");
const newStaffNameInput = document.getElementById("newStaffName");
const staffListEl = document.getElementById("staffList");

const modalOverlay = document.getElementById("modalOverlay");
const modalDate = document.getElementById("modalDate");
const modalBody = document.getElementById("modalBody");
const modalClose = document.getElementById("modalClose");
const modalSave = document.getElementById("modalSave");
const modalActions = document.getElementById("modalActions");

const toastEl = document.getElementById("toast");

let modalDateStr = null;
let modalMode = null; // "staff" or "admin"

const STATUS_SYMBOL = { avail: "○", unavail: "×", maybe: "△" };
const STATUS_LABEL = { avail: "出勤可能", unavail: "出勤不可", maybe: "時間相談" };

function statusSymbol(status) { return STATUS_SYMBOL[status] || ""; }
function statusLabel(status) { return STATUS_LABEL[status] || "未回答"; }
function statusClass(status) { return status ? `status-${status}` : ""; }

// --------------------------------------------------------------
// ユーティリティ
// --------------------------------------------------------------
function pad2(n) { return String(n).padStart(2, "0"); }

function formatDate(y, m, d) {
  return `${y}-${pad2(m + 1)}-${pad2(d)}`;
}

function monthRange(y, m) {
  const start = formatDate(y, m, 1);
  const lastDay = new Date(y, m + 1, 0).getDate();
  const end = formatDate(y, m, lastDay);
  return { start, end, lastDay };
}

function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.remove("hidden");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toastEl.classList.add("hidden"), 2200);
}

function shortTime(t) {
  if (!t) return "?";
  return t.replace(/^0/, "");
}

function staffNameById(id) {
  const s = staffList.find(s => s.id === id);
  return s ? s.name : "(不明)";
}

function noteIconSvg(size) {
  return `<svg class="note-icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>`;
}

// --------------------------------------------------------------
// タブ切り替え(管理者用タブはPINで保護。スタッフ管理も管理者用タブ内にあるため
// 同じ保護がかかる)
// --------------------------------------------------------------
tabsNav.addEventListener("click", (e) => {
  const btn = e.target.closest(".tab-btn");
  if (!btn) return;
  const tab = btn.dataset.tab;

  if (tab === "admin" && !isAdminUnlocked) {
    const pin = window.prompt("管理者用の暗証番号(PIN)を入力してください");
    if (pin === null) return;
    if (pin !== ADMIN_PIN) {
      showToast("暗証番号が違います");
      return;
    }
    isAdminUnlocked = true;
    sessionStorage.setItem("shiftapp_admin", "1");
  }

  document.querySelectorAll(".tab-btn").forEach(b => b.classList.toggle("active", b === btn));
  document.querySelectorAll(".tab-panel").forEach(p => p.classList.toggle("active", p.id === `tab-${tab}`));
});

// --------------------------------------------------------------
// 月ナビゲーション(スタッフ用・管理者用で共通の月を使う)
// --------------------------------------------------------------
function changeMonth(delta) {
  currentMonth += delta;
  if (currentMonth < 0) { currentMonth = 11; currentYear--; }
  if (currentMonth > 11) { currentMonth = 0; currentYear++; }
  subscribeMonthEntries();
  renderAll();
}

document.getElementById("prevMonthStaff").addEventListener("click", () => changeMonth(-1));
document.getElementById("nextMonthStaff").addEventListener("click", () => changeMonth(1));
document.getElementById("prevMonthAdmin").addEventListener("click", () => changeMonth(-1));
document.getElementById("nextMonthAdmin").addEventListener("click", () => changeMonth(1));

// --------------------------------------------------------------
// スタッフ選択(スタッフ用タブ)
// --------------------------------------------------------------
staffSelect.addEventListener("change", () => {
  selectedStaffId = staffSelect.value;
  localStorage.setItem("shiftapp_staffId", selectedStaffId);
  renderStaffCalendar();
});

// --------------------------------------------------------------
// スタッフ管理: 追加・削除(管理者用タブ内)
// --------------------------------------------------------------
addStaffForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = newStaffNameInput.value.trim();
  if (!name) return;
  await addDoc(staffCol, { name, createdAt: Date.now() });
  newStaffNameInput.value = "";
  showToast("スタッフを追加しました");
});

staffListEl.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-del]");
  if (!btn) return;
  const id = btn.dataset.del;
  const name = staffNameById(id);
  if (!window.confirm(`「${name}」を削除しますか?(過去のシフト記録は残ります)`)) return;
  await deleteDoc(doc(db, "staff", id));
  showToast("スタッフを削除しました");
});

// --------------------------------------------------------------
// Firestore 購読: スタッフ一覧
// --------------------------------------------------------------
onSnapshot(staffCol, (snap) => {
  staffList = snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  renderStaffSelect();
  renderStaffManageList();
  renderAll();
});

function renderStaffSelect() {
  const prev = selectedStaffId;
  staffSelect.innerHTML = `<option value="">選択してください</option>` +
    staffList.map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join("");
  if (staffList.some(s => s.id === prev)) {
    staffSelect.value = prev;
  } else {
    selectedStaffId = "";
  }
}

function renderStaffManageList() {
  if (staffList.length === 0) {
    staffListEl.innerHTML = `<li style="border:none;color:var(--muted);">まだスタッフが登録されていません。</li>`;
    return;
  }
  staffListEl.innerHTML = staffList.map(s => `
    <li>
      <span>${escapeHtml(s.name)}</span>
      <button data-del="${s.id}">削除</button>
    </li>
  `).join("");
}

// --------------------------------------------------------------
// Firestore 購読: 表示中の月のシフトエントリ
// --------------------------------------------------------------
function subscribeMonthEntries() {
  if (unsubEntries) unsubEntries();
  const { start, end } = monthRange(currentYear, currentMonth);
  const q = query(entriesCol, where("date", ">=", start), where("date", "<=", end));
  unsubEntries = onSnapshot(q, (snap) => {
    monthEntries = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderAll();
  }, (err) => {
    console.error(err);
    showToast("データの取得に失敗しました");
  });
}

function entriesForDate(dateStr) {
  return monthEntries.filter(e => e.date === dateStr);
}

// --------------------------------------------------------------
// カレンダー描画(共通部分)
// --------------------------------------------------------------
function buildCalendarSkeleton(container) {
  container.innerHTML = "";
  DOW.forEach(d => {
    const el = document.createElement("div");
    el.className = "cal-dow";
    el.textContent = d;
    container.appendChild(el);
  });
}

function renderAll() {
  const label = `${currentYear}年 ${currentMonth + 1}月`;
  monthLabelStaff.textContent = label;
  monthLabelAdmin.textContent = label;
  renderStaffCalendar();
  renderAdminCalendar();
}

function renderStaffCalendar() {
  buildCalendarSkeleton(calendarStaff);
  const firstDow = new Date(currentYear, currentMonth, 1).getDay();
  const { lastDay } = monthRange(currentYear, currentMonth);
  const todayStr = formatDate(today.getFullYear(), today.getMonth(), today.getDate());

  for (let i = 0; i < firstDow; i++) {
    calendarStaff.appendChild(emptyCell());
  }

  for (let d = 1; d <= lastDay; d++) {
    const dateStr = formatDate(currentYear, currentMonth, d);
    const dayEntries = entriesForDate(dateStr);
    const mine = selectedStaffId ? dayEntries.find(e => e.staffId === selectedStaffId) : null;

    const cell = document.createElement("div");
    cell.className = "cal-cell";
    if (dateStr === todayStr) cell.classList.add("today");
    if (mine && mine.status && !mine.assigned) cell.classList.add(statusClass(mine.status));
    if (selectedStaffId) {
      cell.classList.add("clickable");
      cell.addEventListener("click", () => openStaffStatusModal(dateStr));
    }

    const dateEl = document.createElement("div");
    dateEl.className = "cal-date";
    dateEl.textContent = d;
    cell.appendChild(dateEl);

    if (mine && mine.status && !mine.assigned) {
      const symbolEl = document.createElement("div");
      symbolEl.className = "cal-status-symbol";
      symbolEl.textContent = statusSymbol(mine.status);
      cell.appendChild(symbolEl);
    }

    if (mine && mine.assigned) {
      // アサイン済みの場合は、実際の出勤時間を表示する(1行に収まるよう短縮表記)
      const hasTime = mine.startTime || mine.endTime;
      const timeLabel = hasTime
        ? `${shortTime(mine.startTime)}-${shortTime(mine.endTime)}`
        : "確定";
      const badges = document.createElement("div");
      badges.className = "cal-badges";
      badges.innerHTML = `<span class="badge assigned time-badge">${escapeHtml(timeLabel)}</span>`;
      cell.appendChild(badges);
    }

    calendarStaff.appendChild(cell);
  }
}

function renderAdminCalendar() {
  buildCalendarSkeleton(calendarAdmin);
  const firstDow = new Date(currentYear, currentMonth, 1).getDay();
  const { lastDay } = monthRange(currentYear, currentMonth);
  const todayStr = formatDate(today.getFullYear(), today.getMonth(), today.getDate());

  for (let i = 0; i < firstDow; i++) {
    calendarAdmin.appendChild(emptyCell());
  }

  for (let d = 1; d <= lastDay; d++) {
    const dateStr = formatDate(currentYear, currentMonth, d);
    const dayEntries = entriesForDate(dateStr).filter(e => e.status || e.assigned);

    const cell = document.createElement("div");
    cell.className = "cal-cell clickable";
    if (dateStr === todayStr) cell.classList.add("today");
    cell.addEventListener("click", () => openDayModal(dateStr));

    const dateEl = document.createElement("div");
    dateEl.className = "cal-date";
    dateEl.textContent = d;
    cell.appendChild(dateEl);

    if (dayEntries.length > 0) {
      const badges = document.createElement("div");
      badges.className = "cal-badges";
      badges.innerHTML = dayEntries.slice(0, 4).map(e => {
        const name = staffNameById(e.staffId);
        const short = name.length > 3 ? name.slice(0, 3) : name;
        const cls = e.assigned ? "assigned" : statusClass(e.status);
        const noteCls = e.note ? "has-note" : "";
        const noteIcon = e.note ? noteIconSvg(9) : "";
        return `<span class="badge ${cls} ${noteCls}">${statusSymbol(e.status)}${escapeHtml(short)}${noteIcon}</span>`;
      }).join("");
      cell.appendChild(badges);
    }

    calendarAdmin.appendChild(cell);
  }
}

function emptyCell() {
  const el = document.createElement("div");
  el.className = "cal-cell empty";
  return el;
}

// --------------------------------------------------------------
// スタッフ用: ○/×/△ の選択モーダル
// --------------------------------------------------------------
function openStaffStatusModal(dateStr) {
  if (!selectedStaffId) return;
  modalMode = "staff";
  modalDateStr = dateStr;
  const [y, m, d] = dateStr.split("-").map(Number);
  modalDate.textContent = `${y}年${m}月${d}日 のご希望`;

  const existing = monthEntries.find(e => e.id === `${selectedStaffId}__${dateStr}`);
  const currentStatus = existing ? existing.status : null;
  const currentNote = existing ? (existing.note || "") : "";

  modalBody.innerHTML = `
    <div class="status-choice-grid">
      <button type="button" class="status-choice-btn ${currentStatus === "avail" ? "active" : ""}" data-status="avail">
        ○<span>出勤可能</span>
      </button>
    </div>
    <label class="note-label">
      希望の時間帯や伝えたいこと(任意)
      <textarea id="staffNoteInput" class="note-textarea" placeholder="例: 15時以降なら出勤できます / 〇〇の予定があるので相談したいです">${escapeHtml(currentNote)}</textarea>
    </label>
    ${(currentStatus || currentNote) ? `<button type="button" class="clear-status-btn" id="clearStatusBtn">選択を取り消す</button>` : ""}
    ${existing && existing.assigned ? `<p class="hint">この日はすでにアサイン(確定)されています。変更するとアサインに影響する場合があります。</p>` : ""}
  `;

  modalBody.querySelectorAll(".status-choice-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const alreadyActive = btn.classList.contains("active");
      modalBody.querySelectorAll(".status-choice-btn").forEach(b => b.classList.remove("active"));
      if (!alreadyActive) btn.classList.add("active");
    });
  });

  const clearBtn = document.getElementById("clearStatusBtn");
  if (clearBtn) clearBtn.addEventListener("click", () => setMyStatus(dateStr, null, ""));

  modalActions.classList.remove("hidden");
  modalOverlay.classList.remove("hidden");
}

async function setMyStatus(dateStr, status, note) {
  if (!selectedStaffId) return;
  const docId = `${selectedStaffId}__${dateStr}`;
  const existing = monthEntries.find(e => e.id === docId);
  const ref = doc(db, "shiftEntries", docId);
  const noteVal = (note || "").trim();

  if (!status && !noteVal) {
    if (existing && existing.assigned) {
      if (!window.confirm("この日はすでにアサイン(確定)されています。選択を取り消しますか?")) return;
      await setDoc(ref, { ...existing, status: null, note: "" }, { merge: true });
    } else if (existing) {
      await deleteDoc(ref);
    }
  } else {
    if (existing && existing.assigned && status === "unavail") {
      if (!window.confirm("この日はすでにアサイン(確定)されています。「出勤不可」に変更しますか?")) return;
    }
    await setDoc(ref, {
      staffId: selectedStaffId,
      staffName: staffNameById(selectedStaffId),
      date: dateStr,
      status: status || null,
      note: noteVal,
      assigned: existing ? !!existing.assigned : false,
      startTime: existing ? (existing.startTime || "") : "",
      endTime: existing ? (existing.endTime || "") : ""
    }, { merge: true });
  }

  closeModal();
  showToast("保存しました");
}

// --------------------------------------------------------------
// 管理者用: 日付詳細モーダル
// --------------------------------------------------------------
function openDayModal(dateStr) {
  modalMode = "admin";
  modalDateStr = dateStr;
  const [y, m, d] = dateStr.split("-").map(Number);
  modalDate.textContent = `${y}年${m}月${d}日 のシフト`;

  if (staffList.length === 0) {
    modalBody.innerHTML = `<p style="color:var(--muted);">スタッフが登録されていません。下の「スタッフの追加・削除」から登録してください。</p>`;
  } else {
    const dayEntries = entriesForDate(dateStr);
    modalBody.innerHTML = staffList.map(s => {
      const e = dayEntries.find(en => en.staffId === s.id);
      const status = e ? e.status : null;
      const assigned = !!(e && e.assigned);
      const start = (e && e.startTime) || "";
      const end = (e && e.endTime) || "";
      const note = (e && e.note) || "";
      return `
        <div class="modal-row ${assigned ? "assign-on" : ""}" data-staff="${s.id}">
          <span class="staff-name">${escapeHtml(s.name)}</span>
          <label>${statusSymbol(status)} ${statusLabel(status)}</label>
          <label>
            <input type="checkbox" class="assign-check" ${assigned ? "checked" : ""}>
            アサイン
          </label>
          <span class="time-inputs">
            <input type="time" class="start-time" value="${start}">
            〜
            <input type="time" class="end-time" value="${end}">
          </span>
          ${note ? `<div class="staff-note">${noteIconSvg(13)} ${escapeHtml(note)}</div>` : ""}
        </div>
      `;
    }).join("");

    modalBody.querySelectorAll(".assign-check").forEach(cb => {
      cb.addEventListener("change", (e) => {
        e.target.closest(".modal-row").classList.toggle("assign-on", e.target.checked);
      });
    });
  }

  modalActions.classList.remove("hidden");
  modalOverlay.classList.remove("hidden");
}

function closeModal() {
  modalOverlay.classList.add("hidden");
  modalDateStr = null;
  modalMode = null;
}

modalClose.addEventListener("click", closeModal);
modalOverlay.addEventListener("click", (e) => {
  if (e.target === modalOverlay) closeModal();
});

modalSave.addEventListener("click", async () => {
  if (!modalDateStr) return;

  if (modalMode === "staff") {
    const activeBtn = modalBody.querySelector(".status-choice-btn.active");
    const status = activeBtn ? activeBtn.dataset.status : null;
    const noteInput = document.getElementById("staffNoteInput");
    const note = noteInput ? noteInput.value : "";
    await setMyStatus(modalDateStr, status, note);
    return;
  }

  if (modalMode !== "admin") return;
  const rows = modalBody.querySelectorAll(".modal-row");
  const batch = writeBatch(db);
  const dateStr = modalDateStr;

  rows.forEach(row => {
    const staffId = row.dataset.staff;
    const assigned = row.querySelector(".assign-check").checked;
    const startTime = row.querySelector(".start-time").value;
    const endTime = row.querySelector(".end-time").value;
    const existing = entriesForDate(dateStr).find(en => en.staffId === staffId);
    const status = existing ? existing.status : null;
    const note = existing ? (existing.note || "") : "";
    const docId = `${staffId}__${dateStr}`;
    const ref = doc(db, "shiftEntries", docId);

    if (!assigned && !status && !note) {
      if (existing) batch.delete(ref);
      return;
    }

    batch.set(ref, {
      staffId,
      staffName: staffNameById(staffId),
      date: dateStr,
      status: status || null,
      note,
      assigned,
      startTime: assigned ? startTime : "",
      endTime: assigned ? endTime : ""
    }, { merge: false });
  });

  await batch.commit();
  showToast("保存しました");
  closeModal();
});

// --------------------------------------------------------------
// XSS対策の簡易エスケープ
// --------------------------------------------------------------
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// --------------------------------------------------------------
// 認証(匿名サインイン)してから開始
// --------------------------------------------------------------
onAuthStateChanged(auth, (user) => {
  if (user) {
    subscribeMonthEntries();
    renderAll();
  }
});

signInAnonymously(auth).catch((err) => {
  console.error(err);
  showToast("認証に失敗しました。Firebaseの設定(匿名認証の有効化)を確認してください。");
});
