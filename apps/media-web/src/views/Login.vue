<!-- Replaces Sanyue-ImgHub's single-admin password pages (src/views/Login.vue, AdminLogin.vue,
     src/components/BaseLogin.vue) with Cirrus email-code sign-in. -->
<template>
  <div class="login">
    <div class="tools"><LanguageSwitcher /><ToggleDark /></div>
    <section class="pv-card box" aria-labelledby="login-title">
      <PvLogo />
      <h1 id="login-title">{{ $t("login.title") }}</h1>
      <p class="pv-muted">{{ $t("login.subtitle") }}</p>

      <el-form v-if="stage === 'email'" label-position="top" @submit.prevent="send">
        <el-form-item :label="$t('login.email')" required>
          <el-input v-model="email" type="email" autocomplete="email" size="large" autofocus />
        </el-form-item>
        <el-button type="primary" size="large" native-type="submit" :loading="busy" :disabled="!emailValid" class="wide">
          {{ $t("login.sendCode") }}
        </el-button>
      </el-form>

      <el-form v-else label-position="top" @submit.prevent="verify">
        <p class="pv-muted">{{ $t("login.codeSent", { hint }) }}</p>
        <el-alert v-if="debugCode" type="info" :closable="false" :title="$t('login.debugCode', { code: debugCode })" class="debug" />
        <el-form-item :label="$t('login.code')" required>
          <el-input v-model="code" autocomplete="one-time-code" inputmode="numeric" size="large" autofocus />
        </el-form-item>
        <el-button type="primary" size="large" native-type="submit" :loading="busy" :disabled="code.length < 4" class="wide">
          {{ $t("login.verify") }}
        </el-button>
        <el-button text class="wide back" @click="stage = 'email'">{{ $t("login.back") }}</el-button>
      </el-form>

      <el-alert v-if="error" type="error" :closable="false" :title="error" class="err" />
    </section>
  </div>
</template>

<script>
import { ElMessage } from "element-plus";
import { api } from "@/api/client";
import { resetBootstrap } from "@/router";
import PvLogo from "@/components/Logo.vue";
import ToggleDark from "@/components/ToggleDark.vue";
import LanguageSwitcher from "@/components/LanguageSwitcher.vue";

export default {
  name: "LoginView",
  components: { PvLogo, ToggleDark, LanguageSwitcher },
  data: () => ({ stage: "email", email: "", code: "", challengeId: "", hint: "", debugCode: "", busy: false, error: "" }),
  computed: {
    emailValid() {
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(this.email.trim());
    },
  },
  methods: {
    async send() {
      this.busy = true;
      this.error = "";
      try {
        const r = await api.auth.loginStart(this.email.trim());
        this.challengeId = r.challengeId;
        this.hint = r.delivery?.emailHint ?? this.email;
        this.debugCode = r.delivery?.mode === "local_debug" ? (r.delivery.code ?? "") : "";
        this.stage = "code";
      } catch (e) {
        this.error = e.message || this.$t("errors.generic");
      } finally {
        this.busy = false;
      }
    },
    async verify() {
      this.busy = true;
      this.error = "";
      try {
        const r = await api.auth.loginComplete(this.challengeId, this.code.trim());
        this.$store.commit("setToken", r.token);
        resetBootstrap();
        const next = typeof this.$route.query.next === "string" && this.$route.query.next.startsWith("/") ? this.$route.query.next : "/";
        this.$router.replace(next);
      } catch {
        this.error = this.$t("login.failed");
        ElMessage.error(this.$t("login.failed"));
      } finally {
        this.busy = false;
      }
    },
  },
};
</script>

<style scoped>
.login {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 16px;
  background: radial-gradient(1200px 600px at 10% -10%, var(--pv-brand-soft), transparent), var(--pv-bg);
}
.tools {
  position: fixed;
  top: 16px;
  right: 16px;
  display: flex;
  gap: 8px;
}
.box {
  width: 100%;
  max-width: 400px;
  padding: 32px;
}
h1 {
  font-size: 1.4rem;
  margin: 20px 0 4px;
}
.wide {
  width: 100%;
}
.back {
  margin: 8px 0 0;
}
.err,
.debug {
  margin: 12px 0;
}
</style>
