// Derived from MarSeventh/Sanyue-ImgHub@1621525:src/store/index.js (MIT), modified.
// Kept: the dark-mode state (useDarkMode / cusDarkMode) and its persistence. Replaced: the single-admin session
// flags and upload-channel settings with the Cirrus session, the current org and the current library.
import { createStore } from "vuex";
import { api, getToken, setToken } from "@/api/client";

const PREFS_KEY = "pixvault.media.prefs";

function loadPrefs() {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) || "{}");
  } catch {
    return {};
  }
}
function savePrefs(state) {
  try {
    localStorage.setItem(
      PREFS_KEY,
      JSON.stringify({ useDarkMode: state.useDarkMode, cusDarkMode: state.cusDarkMode, orgId: state.orgId }),
    );
  } catch {
    /* not persisted */
  }
}

const prefs = loadPrefs();

const store = createStore({
  state: {
    token: getToken(),
    user: null,
    orgs: [],
    orgId: prefs.orgId ?? null,
    libraries: [],
    guestLibraries: [],
    useDarkMode: prefs.useDarkMode ?? null,
    cusDarkMode: prefs.cusDarkMode ?? false,
  },
  getters: {
    signedIn: (s) => !!s.token,
    currentOrg: (s) => s.orgs.find((o) => o.id === s.orgId) ?? null,
    useDarkMode: (s) => s.useDarkMode,
    cusDarkMode: (s) => s.cusDarkMode,
  },
  mutations: {
    setToken(s, token) {
      s.token = token;
      setToken(token);
    },
    setUser(s, user) {
      s.user = user;
    },
    setOrgs(s, orgs) {
      s.orgs = orgs;
      if (!orgs.some((o) => o.id === s.orgId)) s.orgId = orgs[0]?.id ?? null;
      savePrefs(s);
    },
    setOrgId(s, id) {
      s.orgId = id;
      savePrefs(s);
    },
    setLibraries(s, libs) {
      s.libraries = libs;
    },
    setGuestLibraries(s, libs) {
      s.guestLibraries = libs;
    },
    setUseDarkMode(s, v) {
      s.useDarkMode = v;
      savePrefs(s);
    },
    setCusDarkMode(s, v) {
      s.cusDarkMode = v;
      savePrefs(s);
    },
    signOut(s) {
      s.token = null;
      s.user = null;
      s.orgs = [];
      s.libraries = [];
      s.guestLibraries = [];
      setToken(null);
    },
  },
  actions: {
    /** Load the session, the caller's orgs and the libraries shared with them as a guest. */
    async bootstrap({ commit }) {
      const session = await api.auth.session();
      commit("setUser", session?.user ?? null);
      // Accept any guest invitations addressed to this verified email before listing.
      await api.libraries.acceptInvitations().catch(() => null);
      const [orgs, guest] = await Promise.all([api.orgs.list(), api.libraries.guestLibraries().catch(() => ({ libraries: [] }))]);
      commit("setOrgs", orgs?.organizations ?? []);
      commit("setGuestLibraries", guest?.libraries ?? []);
    },
    async loadLibraries({ commit, state }) {
      if (!state.orgId) return commit("setLibraries", []);
      const r = await api.libraries.list(state.orgId);
      commit("setLibraries", r?.libraries ?? []);
    },
    async signOut({ commit }) {
      await api.auth.logout().catch(() => null);
      commit("signOut");
    },
  },
});

export default store;
