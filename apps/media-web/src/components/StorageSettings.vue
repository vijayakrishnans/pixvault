<!--
  A library's storage (PV7, PV-48): where its files live, and a wizard to use the team's own S3-compatible bucket.
  Managers only (the API answers 404 to anyone else). Steps: 1 bucket details, 2 test, 3 attach (empty library) or
  move files (migration, with progress). Bucket keys are sent once, held only in this form until it closes, and never
  shown again or stored in the browser.
-->
<template>
  <div class="storage" data-test="storage">
    <div class="pv-card">
      <h3>{{ $t("storage.current") }}</h3>
      <div v-if="!state" class="pv-muted">…</div>
      <template v-else>
        <div class="row" data-test="storage-current">
          <el-tag :type="state.current?.kind === 's3-compatible' ? 'success' : 'info'">
            {{ state.current?.kind === "s3-compatible" ? $t("storage.byo") : $t("storage.managed") }}
          </el-tag>
          <span v-if="state.current?.kind === 's3-compatible'" class="mono">{{ state.current.bucket }} · {{ state.current.endpoint }}{{ state.current.prefix ? ` · ${state.current.prefix}` : "" }}</span>
          <el-tag v-if="state.current?.status === 'error'" type="danger" data-test="storage-error">{{ $t("storage.unhealthy", { code: state.current.lastError }) }}</el-tag>
        </div>
        <div v-if="state.current?.kind === 's3-compatible'" class="row">
          <el-button size="small" :loading="busy" data-test="storage-recheck" @click="recheck">{{ $t("storage.recheck") }}</el-button>
          <el-button size="small" :disabled="busy || migrating" data-test="storage-back" @click="moveBack">{{ $t("storage.moveBack") }}</el-button>
          <span v-if="state.current.lastCheckAt" class="pv-muted small">{{ $t("storage.lastCheck", { at: new Date(state.current.lastCheckAt).toLocaleString() }) }}</span>
        </div>
        <div v-if="state.migration" class="migration" data-test="storage-migration" :data-state="state.migration.state">
          <template v-if="state.migration.state === 'copying'">
            <div>{{ $t("storage.copying", { copied: state.migration.copied, total: state.migration.total ?? "?" }) }}</div>
            <el-progress :percentage="percent" :stroke-width="10" />
            <div class="pv-muted small">{{ $t("storage.copyingNote") }}</div>
          </template>
          <el-alert v-else-if="state.migration.state === 'failed'" type="error" :closable="false" :title="$t('storage.failed', { code: state.migration.error })" />
          <el-alert v-else-if="state.migration.state === 'done'" type="success" :closable="false" :title="$t('storage.done', { copied: state.migration.copied })" />
        </div>
      </template>
    </div>

    <div v-if="state && !migrating" class="pv-card">
      <h3>{{ $t("storage.wizardTitle") }}</h3>
      <p class="pv-muted small">{{ $t("storage.wizardIntro") }}</p>
      <el-steps :active="step" finish-status="success" simple class="steps">
        <el-step :title="$t('storage.step1')" />
        <el-step :title="$t('storage.step2')" />
        <el-step :title="$t('storage.step3')" />
      </el-steps>

      <el-form label-position="top" class="form" autocomplete="off" @submit.prevent="test">
        <div class="two">
          <el-form-item :label="$t('storage.endpoint')" :error="fieldError('endpoint')">
            <el-input v-model="form.endpoint" placeholder="https://s3.eu-central-1.amazonaws.com" data-test="storage-endpoint" @input="dirty" />
          </el-form-item>
          <el-form-item :label="$t('storage.region')" :error="fieldError('region')">
            <el-input v-model="form.region" placeholder="auto" data-test="storage-region" @input="dirty" />
          </el-form-item>
          <el-form-item :label="$t('storage.bucket')" :error="fieldError('bucket')">
            <el-input v-model="form.bucket" data-test="storage-bucket" @input="dirty" />
          </el-form-item>
          <el-form-item :label="$t('storage.prefix')" :error="fieldError('prefix')">
            <el-input v-model="form.prefix" placeholder="pixvault/" data-test="storage-prefix" @input="dirty" />
          </el-form-item>
          <el-form-item :label="$t('storage.accessKeyId')" :error="fieldError('accessKeyId')">
            <el-input v-model="form.accessKeyId" autocomplete="off" data-test="storage-key" @input="dirty" />
          </el-form-item>
          <el-form-item :label="$t('storage.secretAccessKey')" :error="fieldError('secretAccessKey')">
            <el-input v-model="form.secretAccessKey" type="password" show-password autocomplete="new-password" data-test="storage-secret" @input="dirty" />
          </el-form-item>
        </div>
        <el-checkbox v-model="form.pathStyle" @change="dirty">{{ $t("storage.pathStyle") }}</el-checkbox>
        <div class="row actions">
          <el-button native-type="submit" :loading="busy && action === 'test'" :disabled="!complete" data-test="storage-test">{{ $t("storage.test") }}</el-button>
          <el-button v-if="tested && empty" type="primary" :loading="busy && action === 'attach'" data-test="storage-attach" @click="attach">{{ $t("storage.attach") }}</el-button>
          <el-button v-if="tested && !empty" type="primary" :loading="busy && action === 'move'" data-test="storage-move" @click="move">{{ $t("storage.move") }}</el-button>
        </div>
      </el-form>

      <ul v-if="steps.length" class="steps-result" data-test="storage-steps">
        <li v-for="s in steps" :key="s.step" :class="s.ok ? 'ok' : 'bad'">
          <span>{{ s.ok ? "✓" : "✕" }}</span> {{ $t(`storage.checks.${s.step}`) }}<span v-if="!s.ok && s.code" class="mono"> — {{ s.code }}</span>
        </li>
      </ul>
      <el-alert v-if="steps.length && !tested" type="warning" :closable="false" :title="hint" data-test="storage-hint" />
    </div>
  </div>
</template>

<script>
import { ElMessage, ElMessageBox } from "element-plus";
import { api } from "@/api/client";

const blank = () => ({ endpoint: "", region: "auto", bucket: "", prefix: "pixvault/", pathStyle: false, accessKeyId: "", secretAccessKey: "" });

/** What a failed check most likely means, by S3 code. */
export function hintFor(code) {
  if (["InvalidAccessKeyId", "SignatureDoesNotMatch", "AccessDenied"].includes(code)) return "keys";
  if (["NoSuchBucket", "PermanentRedirect", "AuthorizationHeaderMalformed"].includes(code)) return "bucket";
  if (["Unreachable", "Timeout"].includes(code)) return "endpoint";
  return "other";
}

export default {
  name: "StorageSettings",
  props: { org: { type: String, required: true }, lib: { type: String, required: true } },
  data: () => ({ state: null, form: blank(), steps: [], tested: false, busy: false, action: "", fields: {}, timer: null }),
  computed: {
    complete() {
      const f = this.form;
      return !!(f.endpoint && f.bucket && f.accessKeyId && f.secretAccessKey);
    },
    migrating() {
      return this.state?.migration?.state === "copying";
    },
    empty() {
      return this.state?.holds?.files === 0;
    },
    percent() {
      const m = this.state?.migration;
      return m?.total ? Math.min(100, Math.round((100 * m.copied) / m.total)) : 0;
    },
    step() {
      return this.tested ? 2 : this.steps.length ? 1 : 0;
    },
    hint() {
      const bad = this.steps.find((s) => !s.ok);
      return this.$t(`storage.hints.${hintFor(bad?.code)}`);
    },
  },
  mounted() {
    this.load();
  },
  beforeUnmount() {
    clearTimeout(this.timer);
    this.form = blank();
  },
  methods: {
    payload() {
      const f = this.form;
      return { endpoint: f.endpoint.trim(), region: f.region.trim() || "auto", bucket: f.bucket.trim(), prefix: f.prefix.trim(), pathStyle: f.pathStyle, accessKeyId: f.accessKeyId.trim(), secretAccessKey: f.secretAccessKey };
    },
    fieldError(name) {
      return this.fields[name]?.[0] ?? "";
    },
    dirty() {
      this.tested = false;
      this.steps = [];
      this.fields = {};
    },
    async load() {
      try {
        this.state = await api.libraries.storage(this.org, this.lib);
      } catch (e) {
        ElMessage.error(e.message);
      }
      clearTimeout(this.timer);
      if (this.migrating) this.timer = setTimeout(() => this.load(), 3000);
    },
    async run(action, fn) {
      this.busy = true;
      this.action = action;
      try {
        return await fn();
      } catch (e) {
        if (e.code === "validation_failed") this.fields = e.details?.fields ?? {};
        else if (e.code === "bucket_check_failed") {
          this.steps = e.details?.steps ?? [];
          this.tested = false;
        } else ElMessage.error(e.message);
        return null;
      } finally {
        this.busy = false;
        this.action = "";
      }
    },
    async test() {
      this.fields = {};
      const r = await this.run("test", () => api.libraries.checkBucket(this.org, this.lib, this.payload()));
      if (!r) return;
      this.steps = r.steps;
      this.tested = r.ok;
    },
    async attach() {
      const r = await this.run("attach", () => api.libraries.attachBucket(this.org, this.lib, this.payload()));
      if (!r) return;
      ElMessage.success(this.$t("storage.attached"));
      this.finish();
    },
    async move() {
      try {
        await ElMessageBox.confirm(this.$t("storage.moveConfirm"), this.$t("storage.move"), { type: "warning" });
      } catch {
        return;
      }
      const r = await this.run("move", () => api.libraries.startMigration(this.org, this.lib, "bucket", this.payload()));
      if (r) this.finish();
    },
    async moveBack() {
      try {
        await ElMessageBox.confirm(this.$t(this.empty ? "storage.backConfirmEmpty" : "storage.backConfirm"), this.$t("storage.moveBack"), { type: "warning" });
      } catch {
        return;
      }
      const id = this.state.current.id;
      const r = await this.run("back", () => (this.empty ? api.libraries.detachBucket(this.org, this.lib, id) : api.libraries.startMigration(this.org, this.lib, "managed")));
      if (r) this.finish();
    },
    async recheck() {
      const r = await this.run("recheck", () => api.libraries.recheckBucket(this.org, this.lib, this.state.current.id));
      if (r) ElMessage[r.ok ? "success" : "warning"](r.ok ? this.$t("storage.healthy") : this.$t("storage.unhealthy", { code: r.backend?.lastError ?? "?" }));
      this.load();
    },
    finish() {
      // The keys leave the page as soon as they've been used.
      this.form = blank();
      this.steps = [];
      this.tested = false;
      this.load();
    },
  },
};
</script>

<style scoped>
.storage { display: grid; gap: 16px; }
.row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-top: 8px; }
.mono { font-family: ui-monospace, monospace; font-size: 12px; overflow-wrap: anywhere; }
.two { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 0 16px; }
.steps { margin: 12px 0; }
.form { margin-top: 8px; }
/* long messages (two lines) push the next field down instead of covering its label */
.form :deep(.el-form-item__error) { position: static; padding-top: 2px; line-height: 1.3; }
.actions { margin-top: 12px; }
.migration { margin-top: 12px; display: grid; gap: 6px; }
.steps-result { list-style: none; padding: 0; margin: 12px 0; display: grid; gap: 4px; }
.steps-result .ok span:first-child { color: var(--el-color-success); }
.steps-result .bad { color: var(--el-color-danger); }
.small { font-size: 12px; }
</style>
