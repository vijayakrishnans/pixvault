<template>
  <div class="onb">
    <section class="pv-card box" aria-labelledby="onb-title">
      <PvLogo />
      <h1 id="onb-title">{{ $t("onboarding.title") }}</h1>
      <p class="pv-muted">{{ $t("onboarding.subtitle") }}</p>
      <el-form label-position="top" @submit.prevent="create">
        <el-form-item :label="$t('onboarding.name')" required>
          <el-input v-model="name" maxlength="100" size="large" autofocus />
        </el-form-item>
        <el-button type="primary" size="large" native-type="submit" :loading="busy" :disabled="!name.trim()" class="wide">
          {{ $t("onboarding.create") }}
        </el-button>
      </el-form>
      <el-alert v-if="error" type="error" :closable="false" :title="error" class="err" />
    </section>
  </div>
</template>

<script>
import { api } from "@/api/client";
import PvLogo from "@/components/Logo.vue";

export default {
  name: "OnboardingView",
  components: { PvLogo },
  data: () => ({ name: "", busy: false, error: "" }),
  methods: {
    async create() {
      this.busy = true;
      this.error = "";
      try {
        const name = this.name.trim();
        let r;
        try {
          r = await api.orgs.create(name);
        } catch (e) {
          // Org slugs are unique across the service: a common team name is often taken. Retry once with a suffix.
          if (e?.status !== 409) throw e;
          const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "team";
          const suffix = Array.from(crypto.getRandomValues(new Uint8Array(3)), (b) => (b % 36).toString(36)).join("");
          r = await api.orgs.create(name, `${base}-${suffix}`);
        }
        const orgs = await api.orgs.list();
        this.$store.commit("setOrgs", orgs?.organizations ?? []);
        this.$store.commit("setOrgId", r.organization.id);
        this.$router.replace({ name: "home" });
      } catch (e) {
        this.error = e.message || this.$t("errors.generic");
      } finally {
        this.busy = false;
      }
    },
  },
};
</script>

<style scoped>
.onb {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 16px;
}
.box {
  width: 100%;
  max-width: 420px;
  padding: 32px;
}
h1 {
  font-size: 1.4rem;
  margin: 20px 0 4px;
}
.wide {
  width: 100%;
}
.err {
  margin-top: 12px;
}
</style>
