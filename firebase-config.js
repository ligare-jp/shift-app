// ==============================================================
// Firebase の設定ファイル
// --------------------------------------------------------------
// Firebase コンソール (https://console.firebase.google.com/) で
// プロジェクトを作成し、「プロジェクトの設定」>「全般」>「マイアプリ」
// (ウェブアプリ) で表示される設定値に、下の YOUR_XXXXX 部分を
// すべて置き換えてください。詳しい手順は README.md を参照してください。
// ==============================================================

export const firebaseConfig = {
  apiKey: "AIzaSyAAjACdl1IF9c4id3FOk_CErk1H2v6DtIA",
  authDomain: "ligare-shift-app.firebaseapp.com",
  projectId: "ligare-shift-app",
  storageBucket: "ligare-shift-app.firebasestorage.app",
  messagingSenderId: "511049419985",
  appId: "1:511049419985:web:1bcf141aff85bbd2cc9f0"
};

// 「管理者用」タブに入るときに要求する暗証番号(PIN)。
// 好きな文字列・数字に変更してください。厳密なセキュリティではなく、
// 誰でもURLを知っていれば操作できてしまう点に注意してください。
export const ADMIN_PIN = "1234";
