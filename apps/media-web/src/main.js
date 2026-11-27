// Derived from MarSeventh/Sanyue-ImgHub@1621525:src/main.js (MIT), modified.
// Kept: Element Plus with its icons, the dark-mode class logic (follow the system unless the user chose).
// Removed: the remote site config, the custom title and icon, the wallpaper loader and the entry animation.
import { createApp } from "vue";
import ElementPlus from "element-plus";
import "element-plus/dist/index.css";
import "element-plus/theme-chalk/dark/css-vars.css";
import { ChatLineRound, Folder, Menu, Plus, Setting, Share, SwitchButton } from "@element-plus/icons-vue";

import App from "./App.vue";
import router from "./router";
import store from "./store";
import i18n, { initializeLocale } from "./locales";
import "./styles/global.css";

function applyDarkModeClass(isDark) {
  document.documentElement.classList.toggle("dark", !!isDark);
}

function initDarkModeClass() {
  let isDark;
  if (store.state.cusDarkMode && store.state.useDarkMode !== null) {
    isDark = store.state.useDarkMode;
  } else {
    isDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    store.commit("setUseDarkMode", isDark);
  }
  applyDarkModeClass(isDark);
}

initializeLocale();
initDarkModeClass();
store.subscribe((mutation, state) => {
  if (mutation.type === "setUseDarkMode" && state.cusDarkMode) applyDarkModeClass(state.useDarkMode);
  if (mutation.type === "setCusDarkMode" && !mutation.payload) initDarkModeClass();
});
window.matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => {
  if (!store.state.cusDarkMode) initDarkModeClass();
});

const app = createApp(App);
// Only the icons the app uses (registering all of them added ~300 kB).
for (const [key, component] of Object.entries({ ChatLineRound, Folder, Menu, Plus, Setting, Share, SwitchButton })) app.component(key, component);
app.use(store).use(router).use(ElementPlus).use(i18n);
router.isReady().finally(() => app.mount("#app"));
