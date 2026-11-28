<!-- Comments on one file (PV6): the thread, oldest first, and a box to add one, with teammates to notify by email.
     Comment text is shown as plain text (never as HTML). Authors edit their words; authors, editors and managers
     resolve or delete. -->
<template>
  <div class="comments" data-test="comments">
    <h3 class="section">{{ $t("comments.title") }}</h3>
    <el-skeleton v-if="loading" :rows="2" animated />
    <p v-else-if="!items.length" class="pv-muted small">{{ $t("comments.none") }}</p>
    <ul v-else class="list">
      <li v-for="c in items" :key="c.id" :class="{ resolved: c.resolvedAt }">
        <div class="meta">
          <strong>{{ who(c.author) }}</strong>
          <span class="pv-muted small">{{ new Date(c.createdAt).toLocaleString() }}<span v-if="c.editedAt"> · {{ $t("comments.edited") }}</span></span>
          <el-tag v-if="c.resolvedAt" size="small" type="success">{{ $t("comments.resolved") }}</el-tag>
          <span class="grow" />
          <el-button v-if="c.author === me && editing !== c.id" size="small" text @click="startEdit(c)">{{ $t("comments.edit") }}</el-button>
          <el-button v-if="c.author === me || canModerate" size="small" text @click="resolve(c)">{{ c.resolvedAt ? $t("comments.reopen") : $t("comments.resolve") }}</el-button>
          <el-button v-if="c.author === me || canModerate" size="small" text type="danger" @click="remove(c)">{{ $t("upload.delete") }}</el-button>
        </div>
        <div v-if="editing === c.id" class="edit">
          <el-input v-model="editText" type="textarea" :autosize="{ minRows: 2, maxRows: 6 }" maxlength="4000" />
          <div class="row">
            <el-button size="small" type="primary" @click="saveEdit(c)">{{ $t("library.save") }}</el-button>
            <el-button size="small" @click="editing = null">{{ $t("browse.cancel") }}</el-button>
          </div>
        </div>
        <p v-else class="body">{{ c.body }}</p>
        <p v-if="c.mentions.length" class="pv-muted small">{{ $t("comments.notified", { names: c.mentions.map(who).join(", ") }) }}</p>
      </li>
    </ul>
    <el-form class="add" @submit.prevent="add">
      <el-input v-model="text" type="textarea" :autosize="{ minRows: 2, maxRows: 6 }" maxlength="4000" :placeholder="$t('comments.placeholder')" data-test="comment-input" />
      <div class="row">
        <el-select v-model="mentions" multiple filterable collapse-tags size="small" :placeholder="$t('comments.notify')" class="notify" data-test="comment-notify">
          <el-option v-for="m in people" :key="m.id" :value="m.id" :label="m.label" />
        </el-select>
        <el-button size="small" type="primary" native-type="submit" :disabled="!text.trim()" :loading="busy" data-test="comment-send">{{ $t("comments.send") }}</el-button>
      </div>
    </el-form>
  </div>
</template>

<script>
import { ElMessage, ElMessageBox } from "element-plus";
import { api } from "@/api/client";

export default {
  name: "CommentsPanel",
  props: {
    org: { type: String, required: true },
    lib: { type: String, required: true },
    fileId: { type: String, required: true },
    /** subject id → name (email) of library members */
    names: { type: Object, default: () => ({}) },
    me: { type: String, default: null },
    canModerate: { type: Boolean, default: false },
  },
  data: () => ({ items: [], loading: false, busy: false, text: "", mentions: [], editing: null, editText: "" }),
  computed: {
    people() {
      return Object.entries(this.names)
        .filter(([id]) => id !== this.me && id.startsWith("usr_"))
        .map(([id, label]) => ({ id, label }))
        .sort((a, b) => a.label.localeCompare(b.label));
    },
  },
  watch: {
    fileId: {
      immediate: true,
      handler() {
        this.text = "";
        this.mentions = [];
        this.editing = null;
        this.reload();
      },
    },
  },
  methods: {
    who(id) {
      return this.names[id] ?? this.$t("browse.someone");
    },
    async reload() {
      const id = this.fileId;
      this.loading = this.items.length === 0;
      try {
        const r = await api.libraries.comments(this.org, this.lib, id);
        if (id === this.fileId) this.items = r.comments;
      } catch {
        if (id === this.fileId) this.items = [];
      } finally {
        this.loading = false;
      }
    },
    async add() {
      if (!this.text.trim()) return;
      this.busy = true;
      try {
        const r = await api.libraries.addComment(this.org, this.lib, this.fileId, this.text.trim(), this.mentions);
        if (this.mentions.length && r.mentioned < this.mentions.length) ElMessage.info(this.$t("comments.someNotNotified"));
        this.text = "";
        this.mentions = [];
        await this.reload();
      } catch (e) {
        ElMessage.error(e.message || this.$t("errors.generic"));
      } finally {
        this.busy = false;
      }
    },
    startEdit(c) {
      this.editing = c.id;
      this.editText = c.body;
    },
    async saveEdit(c) {
      try {
        await api.libraries.updateComment(this.org, this.lib, this.fileId, c.id, { body: this.editText });
        this.editing = null;
        await this.reload();
      } catch (e) {
        ElMessage.error(e.message || this.$t("errors.generic"));
      }
    },
    async resolve(c) {
      try {
        await api.libraries.updateComment(this.org, this.lib, this.fileId, c.id, { resolved: !c.resolvedAt });
        await this.reload();
      } catch (e) {
        ElMessage.error(e.message || this.$t("errors.generic"));
      }
    },
    async remove(c) {
      try {
        await ElMessageBox.confirm(this.$t("comments.deleteConfirm"), { type: "warning" });
      } catch {
        return;
      }
      try {
        await api.libraries.deleteComment(this.org, this.lib, this.fileId, c.id);
        await this.reload();
      } catch (e) {
        ElMessage.error(e.message || this.$t("errors.generic"));
      }
    },
  },
};
</script>

<style scoped>
.section {
  font-size: 0.95rem;
  margin: 16px 0 8px;
}
.list {
  list-style: none;
  padding: 0;
  margin: 0 0 12px;
  display: grid;
  gap: 10px;
}
.list li.resolved {
  opacity: 0.7;
}
.meta {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.grow {
  flex: 1;
}
.body {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  margin: 4px 0 0;
}
.row {
  display: flex;
  gap: 8px;
  margin-top: 6px;
  align-items: center;
}
.notify {
  flex: 1;
}
.small {
  font-size: 0.8rem;
}
</style>
