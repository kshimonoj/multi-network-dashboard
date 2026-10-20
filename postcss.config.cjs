// PostCSS 設定(86)。Vite が自動で読み込む(dev の middleware モードと build の両方)。
//
// Material Theme Builder が生成した src/theme/*.css はクラスセレクタ(.light / .dark)で値を持つが、
// このアプリのテーマ切替は <html data-theme="dark|light"> の属性方式。生成ファイルは編集しない
// (値を変えるときは Theme Builder で再生成して差し替える)ので、取り込み時にセレクタだけ読み替える。
//
//   src/theme/light.css の `.light` → html[data-theme="light"]
//   src/theme/dark.css  の `.dark`  → :root, html[data-theme="dark"]
//     (:root は data-theme が付く前の一瞬のフォールバック。従来の theme.css と同じくダーク)
//
// medium-contrast / high-contrast の 4 ファイルは意図的に読み替えない(将来 UI を作るときに繋ぐ)。
// 読み替え対象は「ファイル名 + セレクタ」の完全一致だけに絞り、他の CSS には一切触れない。
const path = require("node:path");

const THEME_DIR = path.join(__dirname, "src", "theme");
const SELECTOR_MAP = {
  "light.css": { ".light": 'html[data-theme="light"]' },
  "dark.css": { ".dark": ':root,\nhtml[data-theme="dark"]' },
};

const m3ThemeSelectors = {
  postcssPlugin: "m3-theme-selectors",
  // theme.css の @import は Vite の postcss-import が先に展開する。展開後の全ルールを最後に見る。
  OnceExit(root) {
    root.walkRules((rule) => {
      const file = rule.source?.input?.file;
      if (!file || path.dirname(file) !== THEME_DIR) return;
      const to = SELECTOR_MAP[path.basename(file)]?.[rule.selector.trim()];
      if (to) rule.selector = to;
    });
  },
};

module.exports = { plugins: [m3ThemeSelectors] };
