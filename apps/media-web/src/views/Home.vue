<template>
  <AppShell>
    <template #title>{{ currentOrg ? currentOrg.name : $t("home.title") }}</template>

    <div class="head">
      <h1>{{ $t("home.title") }}</h1>
      <el-button v-if="canCreate" type="primary" @click="dialog = true"><el-icon><Plus /></el-icon>&nbsp;{{ $t("home.new") }}</el-button>
    </div>

    <el-skeleton v-if="loading" :rows="3" animated />
    <el-empty v-else-if="!libraries.length" :description="canCreate ? $t('home.empty') : $t('home.emptyViewer')" />
    <div v-else class="grid">
      <article v-for="l in libraries" :key="l.id" class="pv-card lib">
        <div class="lib-top">
          <el-icon class="lib-icon"><Folder /></el-icon>
          <h2>{{ l.name }}</h2>
        </div>
        <dl>
          <dt>{{ $t("home.role") }}</dt>
          <dd><el-tag size="small">{{ $t(`members.roles.${l.myRole}`) }}</el-tag></dd>
          <dt>{{ $t("home.visibility") }}</dt>
          <dd>{{ l.visibilityDefault === "public" ? $t("library.public") : $t("library.private") }}</dd>
        </dl>
        <router-link :to="{ name: 'library', params: { org: l.orgId, lib: l.id } }">
          <el-button>{{ $t("home.open") }}</el-button>
        </router-link>
      </article>
    </div>

    <el-dialog v-model="dialog" :title="$t('home.new')" width="min(460px, 92vw)">
      <el-form label-position="top" @submit.prevent="create">
        <el-form-item :label="$t('library.name')" required>
          <el-input v-model="form.name" maxlength="100" @input="autoSlug" />
        </el-form-item>
        <el-form-item :label="$t('library.slug')">
          <el-input v-model="form.slug" maxlength="63" @input="slugTouched = true" />
          <div class="pv-muted hint">{{ $t("library.slugHint", { slug: form.slug || "…" }) }}</div>
        </el-form-item>
        <el-form-item>
          <el-radio-group v-model="form.visibilityDefault">
            <el-radio-button value="private">{{ $t("library.private") }}</el-radio-button>
            <el-radio-button value="public">{{ $t("library.public") }}</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item>
          <el-checkbox v-model="form.everyoneInOrg">{{ $t("library.everyone") }}</el-checkbox>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialog = false">{{ $t("library.cancel") }}</el-button>
        <el-button type="primary" :loading="busy" :disabled="!form.name.trim()" @click="create">{{ $t("library.create") }}</el-button>
      </template>
    </el-dialog>
  </AppShell>
</template>

<script>
import { mapGetters, mapState } from "vuex";
import { ElMessage } from "element-plus";
import { api } from "@/api/client";
import AppShell from "@/components/AppShell.vue";

const slugify = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);

export default {
  name: "HomeView",
  components: { AppShell },
  data: () => ({
    loading: true,
    dialog: false,
    busy: false,
    slugTouched: false,
    form: { name: "", slug: "", visibilityDefault: "private", everyoneInOrg: false },
  }),
  computed: {
    ...mapState(["libraries", "orgId"]),
    ...mapGetters(["currentOrg"]),
    canCreate() {
      // The server decides (policy-worker); this only hides the button from people who'd be refused.
      return !!this.orgId;
    },
  },
  watch: {
    orgId() {
      this.load();
    },
  },
  mounted() {
    this.load();
  },
  methods: {
    async load() {
      this.loading = true;
      try {
        await this.$store.dispatch("loadLibraries");
        await this.ensureDefaultLibrary();
      } catch (e) {
        if (e?.status !== 404) ElMessage.error(e.message || this.$t("errors.generic"));
        this.$store.commit("setLibraries", []);
      } finally {
        this.loading = false;
      }
    },
    /** An org's first visit by someone allowed to create gets a default "Library" (design §1.1). */
    async ensureDefaultLibrary() {
      if (this.libraries.length || !this.orgId) return;
      try {
        await api.libraries.create(this.orgId, { name: "Library", slug: "library" });
        await this.$store.dispatch("loadLibraries");
      } catch {
        /* not allowed (viewer) or already exists: leave the empty state */
      }
    },
    autoSlug() {
      if (!this.slugTouched) this.form.slug = slugify(this.form.name);
    },
    async create() {
      this.busy = true;
      try {
        const body = { ...this.form, name: this.form.name.trim() };
        if (!body.slug) delete body.slug;
        const r = await api.libraries.create(this.orgId, body);
        this.dialog = false;
        this.form = { name: "", slug: "", visibilityDefault: "private", everyoneInOrg: false };
        this.slugTouched = false;
        await this.$store.dispatch("loadLibraries");
        this.$router.push({ name: "library", params: { org: r.library.orgId, lib: r.library.id } });
      } catch (e) {
        ElMessage.error(e.status === 412 ? this.$t("errors.limit") : e.message || this.$t("errors.generic"));
      } finally {
        this.busy = false;
      }
    },
  },
};
</script>

<style scoped>
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 16px;
}
h1 {
  font-size: 1.5rem;
  margin: 0;
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 16px;
}
.lib-top {
  display: flex;
  align-items: center;
  gap: 10px;
}
.lib-icon {
  font-size: 1.4rem;
  color: var(--pv-brand);
}
h2 {
  font-size: 1.05rem;
  margin: 0;
  overflow-wrap: anywhere;
}
dl {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 6px 12px;
  font-size: 0.88rem;
  margin: 14px 0;
}
dt {
  color: var(--pv-muted);
}
dd {
  margin: 0;
}
.hint {
  font-size: 0.8rem;
  margin-top: 4px;
}
.soon {
  margin-top: 24px;
  font-size: 0.9rem;
}
</style>
