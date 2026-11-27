<!-- Links for one file: URL, Markdown, HTML and BBCode, a time-limited
     signed link for private files, and a public/private switch for editors and managers. -->
<template>
  <el-dialog :model-value="!!file" :title="file ? file.name : ''" width="560px" append-to-body @close="$emit('close')">
    <template v-if="file">
      <div class="row">
        <el-tag :type="isPublic ? 'success' : 'info'" size="small">{{ $t(isPublic ? "links.public" : "links.private") }}</el-tag>
        <el-switch
          v-if="canEdit"
          :model-value="isPublic"
          :loading="saving"
          :active-text="$t('links.makePublic')"
          data-test="visibility"
          @change="toggle"
        />
      </div>
      <p class="pv-muted small">{{ $t(isPublic ? "links.publicHint" : "links.privateHint") }}</p>

      <div v-if="!isPublic" class="row">
        <el-select v-model="ttl" size="small" style="width: 160px" data-test="ttl">
          <el-option v-for="t in ttls" :key="t.key" :value="t.seconds" :label="$t(`links.ttl.${t.key}`)" />
        </el-select>
        <el-button size="small" type="primary" :loading="signing" data-test="sign" @click="sign">{{ $t("links.createSigned") }}</el-button>
        <span v-if="expiresAt" class="pv-muted small">{{ $t("links.expires", { at: new Date(expiresAt).toLocaleString() }) }}</span>
      </div>

      <template v-if="url">
        <el-radio-group v-model="format" size="small" class="formats">
          <el-radio-button v-for="f in formats" :key="f" :value="f">{{ $t(`links.format.${f}`) }}</el-radio-button>
        </el-radio-group>
        <el-input :model-value="links[format]" readonly type="textarea" :rows="2" data-test="link" />
        <div class="actions">
          <el-button size="small" type="primary" data-test="copy" @click="copy">{{ $t("links.copy") }}</el-button>
        </div>
      </template>
    </template>
  </el-dialog>
</template>

<script>
import { ElMessage } from "element-plus";
import { api } from "@/api/client";
import { LINK_FORMATS, SIGNED_TTLS, buildLinks } from "@/utils/links";

export default {
  name: "LinkDialog",
  props: {
    file: { type: Object, default: null },
    org: { type: String, required: true },
    lib: { type: String, required: true },
    canEdit: { type: Boolean, default: false },
  },
  emits: ["close", "updated"],
  data: () => ({ format: "url", ttl: 3600, signed: null, expiresAt: null, signing: false, saving: false, formats: LINK_FORMATS, ttls: SIGNED_TTLS }),
  computed: {
    isPublic() {
      return this.file?.visibility === "public" && this.file?.status === "public";
    },
    url() {
      return this.isPublic ? this.file?.url : this.signed;
    },
    links() {
      return this.url ? buildLinks(this.url, this.file.name, this.file.mime) : {};
    },
  },
  watch: {
    file() {
      this.signed = null;
      this.expiresAt = null;
    },
  },
  methods: {
    async sign() {
      this.signing = true;
      try {
        const r = await api.libraries.signedUrl(this.org, this.lib, this.file.id, this.ttl);
        this.signed = r.url;
        this.expiresAt = r.expiresAt;
      } catch (e) {
        ElMessage.error(e.message);
      } finally {
        this.signing = false;
      }
    },
    async toggle(on) {
      this.saving = true;
      try {
        const r = await api.libraries.setVisibility(this.org, this.lib, this.file.id, on ? "public" : "private");
        this.signed = null;
        this.expiresAt = null;
        this.$emit("updated", r.file);
      } catch (e) {
        ElMessage.error(e.message);
      } finally {
        this.saving = false;
      }
    },
    async copy() {
      try {
        await navigator.clipboard.writeText(this.links[this.format]);
        ElMessage.success(this.$t("links.copied"));
      } catch {
        ElMessage.warning(this.$t("links.copyFailed"));
      }
    },
  },
};
</script>

<style scoped>
.row {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}
.formats {
  margin: 12px 0 8px;
}
.actions {
  margin-top: 8px;
  text-align: right;
}
.small {
  font-size: 12px;
}
</style>
