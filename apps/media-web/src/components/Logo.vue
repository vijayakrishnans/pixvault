<template>
  <span class="pv-logo" :class="{ compact }">
    <svg viewBox="0 0 64 64" width="28" height="28" aria-hidden="true">
      <rect width="64" height="64" rx="14" fill="#4f46e5" />
      <path d="M18 46V18h15a10 10 0 0 1 0 20h-7v8z" fill="none" stroke="#fff" stroke-width="5" stroke-linejoin="round" />
      <circle cx="44" cy="44" r="5" fill="#a5b4fc" />
    </svg>
    <span v-if="!compact" class="word">Pixvault</span>
  </span>
</template>

<script>
export default { name: "PvLogo", props: { compact: { type: Boolean, default: false } } };
</script>

<style scoped>
.pv-logo {
  display: inline-flex;
  align-items: center;
  gap: 10px;
}
.word {
  font-weight: 700;
  font-size: 1.15rem;
  letter-spacing: -0.01em;
  color: var(--pv-text);
}
</style>
