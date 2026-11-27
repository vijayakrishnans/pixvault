<template>
  <div class="shell">
    <aside class="side" :class="{ open: menuOpen }">
      <div class="side-head">
        <router-link to="/" class="brand" @click="menuOpen = false"><PvLogo /></router-link>
      </div>

      <div v-if="orgs.length" class="block">
        <label class="label" for="org-select">{{ $t("nav.team") }}</label>
        <el-select id="org-select" :model-value="orgId" size="large" class="org-select" @change="switchOrg">
          <el-option v-for="o in orgs" :key="o.id" :label="o.name" :value="o.id" />
        </el-select>
      </div>

      <div class="label">{{ $t("nav.libraries") }}</div>
      <nav class="libs" :aria-label="$t('nav.libraries')">
        <router-link
          v-for="l in libraries"
          :key="l.id"
          :to="{ name: 'librarySettings', params: { org: l.orgId, lib: l.id } }"
          class="lib"
          :class="{ active: $route.params.lib === l.id }"
          @click="menuOpen = false"
        >
          <el-icon><Folder /></el-icon>
          <span class="lib-name">{{ l.name }}</span>
          <span class="lib-role">{{ $t(`members.roles.${l.myRole}`) }}</span>
        </router-link>
      </nav>

      <div v-if="guestLibraries.length" class="block">
        <div class="label">{{ $t("nav.guestOf") }}</div>
        <router-link
          v-for="l in guestLibraries"
          :key="l.id"
          :to="{ name: 'librarySettings', params: { org: l.orgId, lib: l.id } }"
          class="lib"
          @click="menuOpen = false"
        >
          <el-icon><Share /></el-icon>
          <span class="lib-name">{{ l.name }}</span>
        </router-link>
      </div>

      <div class="side-foot">
        <a v-if="consoleUrl" :href="consoleUrl" class="foot-link" target="_blank" rel="noopener">
          <el-icon><Setting /></el-icon>{{ $t("nav.orgAdmin") }}
        </a>
        <button type="button" class="foot-link" @click="signOut">
          <el-icon><SwitchButton /></el-icon>{{ $t("nav.signOut") }}
        </button>
        <div class="who pv-muted">{{ user?.email }}</div>
      </div>
    </aside>

    <div class="main">
      <header class="top">
        <button type="button" class="menu-btn" aria-label="Menu" @click="menuOpen = !menuOpen"><el-icon><Menu /></el-icon></button>
        <div class="top-title"><slot name="title" /></div>
        <div class="top-actions">
          <LanguageSwitcher />
          <ToggleDark />
        </div>
      </header>
      <main class="content"><slot /></main>
    </div>
  </div>
</template>

<script>
import { mapState } from "vuex";
import PvLogo from "./Logo.vue";
import ToggleDark from "./ToggleDark.vue";
import LanguageSwitcher from "./LanguageSwitcher.vue";
import { resetBootstrap } from "@/router";

export default {
  name: "AppShell",
  components: { PvLogo, ToggleDark, LanguageSwitcher },
  data: () => ({ menuOpen: false }),
  computed: {
    ...mapState(["orgs", "orgId", "libraries", "guestLibraries", "user"]),
    consoleUrl() {
      const m = /^pixvault-media-web-([a-z0-9]+)\.(.+)$/.exec(window.location.hostname);
      return m ? `https://pixvault-web-console-next-${m[1]}.${m[2]}` : null;
    },
  },
  methods: {
    async switchOrg(id) {
      this.$store.commit("setOrgId", id);
      await this.$store.dispatch("loadLibraries");
      if (this.$route.name !== "home") this.$router.push({ name: "home" });
    },
    async signOut() {
      await this.$store.dispatch("signOut");
      resetBootstrap();
      this.$router.push({ name: "login" });
    },
  },
};
</script>

<style scoped>
.shell {
  display: flex;
  min-height: 100vh;
}
.side {
  width: 260px;
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 18px 14px;
  background: var(--pv-surface);
  border-right: 1px solid var(--pv-border);
}
.brand {
  text-decoration: none;
}
.label {
  display: block;
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--pv-muted);
  margin: 0 4px 6px;
}
.org-select {
  width: 100%;
}
.libs {
  display: flex;
  flex-direction: column;
  gap: 2px;
  overflow-y: auto;
}
.lib {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 10px;
  color: var(--pv-text);
  text-decoration: none;
}
.lib:hover,
.lib.active {
  background: var(--pv-brand-soft);
}
.lib-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.lib-role {
  font-size: 0.72rem;
  color: var(--pv-muted);
}
.side-foot {
  margin-top: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.foot-link {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 10px;
  border: 0;
  background: none;
  font: inherit;
  color: var(--pv-text);
  cursor: pointer;
  text-decoration: none;
}
.foot-link:hover {
  background: var(--pv-brand-soft);
}
.who {
  font-size: 0.8rem;
  padding: 4px 10px;
  overflow-wrap: anywhere;
}
.main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.top {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 24px;
  border-bottom: 1px solid var(--pv-border);
  background: var(--glass-bg);
  backdrop-filter: blur(12px);
  position: sticky;
  top: 0;
  z-index: 5;
}
.top-title {
  flex: 1;
  font-weight: 600;
  font-size: 1.05rem;
  min-width: 0;
}
.top-actions {
  display: flex;
  gap: 8px;
}
.menu-btn {
  display: none;
  border: 0;
  background: none;
  font-size: 1.3rem;
  color: var(--pv-text);
  cursor: pointer;
}
.content {
  padding: 24px;
  max-width: 1100px;
  width: 100%;
}
@media (max-width: 820px) {
  .side {
    position: fixed;
    inset: 0 auto 0 0;
    z-index: 20;
    transform: translateX(-100%);
    transition: transform 0.2s ease;
  }
  .side.open {
    transform: none;
    box-shadow: 0 0 40px rgba(0, 0, 0, 0.2);
  }
  .menu-btn {
    display: inline-flex;
  }
  .content {
    padding: 16px;
  }
  .top {
    padding: 12px 16px;
  }
}
</style>
