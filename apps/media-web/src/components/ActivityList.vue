<!-- Activity (PV6): who did what, newest first, for the library or one file. Names come from the library's members;
     upload links, the pipeline and operators have their own words. -->
<template>
  <div class="activity" data-test="activity">
    <el-skeleton v-if="loading && !items.length" :rows="3" animated />
    <p v-else-if="!items.length" class="pv-muted small">{{ $t("activity.none") }}</p>
    <ul v-else class="list">
      <li v-for="e in items" :key="e.id">
        <span class="when pv-muted small">{{ new Date(e.at).toLocaleString() }}</span>
        <span class="what">{{ line(e) }}</span>
      </li>
    </ul>
    <div v-if="cursor" class="more"><el-button size="small" text @click="load(true)">{{ $t("upload.more") }}</el-button></div>
  </div>
</template>

<script>
import { api } from "@/api/client";

export default {
  name: "ActivityList",
  props: {
    org: { type: String, required: true },
    lib: { type: String, required: true },
    fileId: { type: String, default: null },
    names: { type: Object, default: () => ({}) },
  },
  data: () => ({ items: [], cursor: null, loading: false }),
  watch: {
    fileId: {
      immediate: true,
      handler() {
        this.items = [];
        this.cursor = null;
        this.load();
      },
    },
  },
  methods: {
    who(actor) {
      if (actor === "pipeline") return this.$t("activity.pipeline");
      if (actor === "operator") return this.$t("activity.operator");
      if (actor === "system") return this.$t("activity.system");
      if (String(actor).startsWith("upl_")) return this.$t("browse.viaUploadLink");
      return this.names[actor] ?? this.$t("browse.someone");
    },
    line(e) {
      const key = `activity.op.${e.op.replace(/\./g, "_")}`;
      const d = e.detail ?? {};
      const text = this.$te(key) ? this.$t(key, { name: d.name ?? "", to: d.to ?? "", from: d.from ?? "", status: d.status ?? "", visibility: d.visibility ?? "", version: d.version ?? "", files: d.files ?? "", collection: d.collection ?? "", folder: e.folder ?? "" }) : e.op;
      return `${this.who(e.actor)} ${text}`;
    },
    async load(more = false) {
      this.loading = true;
      try {
        const r = await api.libraries.activity(this.org, this.lib, { file: this.fileId ?? undefined, cursor: more ? this.cursor : undefined });
        this.items = more ? [...this.items, ...r.activity] : r.activity;
        this.cursor = r.nextCursor;
      } catch {
        if (!more) this.items = [];
      } finally {
        this.loading = false;
      }
    },
    reload() {
      this.cursor = null;
      return this.load();
    },
  },
};
</script>

<style scoped>
.list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: grid;
  gap: 6px;
}
.list li {
  display: grid;
  grid-template-columns: 170px 1fr;
  gap: 8px;
}
.what {
  overflow-wrap: anywhere;
}
.small {
  font-size: 0.8rem;
}
.more {
  text-align: center;
}
@media (max-width: 760px) {
  .list li {
    grid-template-columns: 1fr;
    gap: 0;
  }
}
</style>
