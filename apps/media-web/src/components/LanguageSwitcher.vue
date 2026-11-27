<!-- Derived from MarSeventh/Sanyue-ImgHub@1621525:src/components/LanguageSwitcher.vue (MIT), modified. -->
<template>
  <button type="button" class="language-switcher" :title="$t('language.switchTo')" :aria-label="$t('language.switchTo')" @click="toggleLocale">
    <el-icon class="lang-icon"><ChatLineRound /></el-icon>
    <span class="lang-code">{{ isZh ? "EN" : "ZH" }}</span>
  </button>
</template>

<script>
import { setLocale } from "@/locales";

export default {
  name: "LanguageSwitcher",
  computed: {
    isZh() {
      return this.$i18n.locale === "zh-CN";
    },
  },
  methods: {
    toggleLocale() {
      setLocale(this.isZh ? "en" : "zh-CN");
    },
  },
};
</script>

<style scoped>
.language-switcher {
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 2.5rem;
  padding: 0 10px;
  border-radius: 12px;
  border: 1px solid var(--glass-border);
  background: var(--glass-bg);
  color: var(--theme-toggle-color);
  user-select: none;
  transition: border-color 0.25s ease;
}
.language-switcher:hover {
  border-color: var(--glass-border-hover);
}
.lang-icon {
  font-size: 1.1em;
}
.lang-code {
  font-size: 0.8rem;
  font-weight: 600;
}
</style>
