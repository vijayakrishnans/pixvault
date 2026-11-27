<!-- Derived from MarSeventh/Sanyue-ImgHub@1621525:src/views/NotFound.vue (MIT), modified.
     The upstream illustration and its animation are replaced with the Pixvault mark. -->
<template>
  <div class="nf">
    <section class="pv-card box">
      <PvLogo />
      <div class="code" aria-hidden="true">404</div>
      <h1>{{ $t("notFound.title") }}</h1>
      <p class="pv-muted">{{ $t("notFound.body") }}</p>
      <router-link to="/"><el-button type="primary">{{ $t("notFound.home") }}</el-button></router-link>
    </section>
  </div>
</template>

<script>
import PvLogo from "@/components/Logo.vue";
export default { name: "NotFound", components: { PvLogo } };
</script>

<style scoped>
.nf {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 16px;
}
.box {
  max-width: 420px;
  width: 100%;
  text-align: center;
  padding: 32px;
}
.code {
  font-size: 4rem;
  font-weight: 800;
  color: var(--pv-brand);
  margin-top: 12px;
}
h1 {
  font-size: 1.3rem;
}
</style>
