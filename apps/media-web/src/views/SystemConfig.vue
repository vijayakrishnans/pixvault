<!-- Derived from MarSeventh/Sanyue-ImgHub@1621525:src/views/SystemConfig.vue (MIT), modified.
     The instance-wide system settings (with SysCogUpload, SysCogSecurity and SysCogOthers) become one library's
     settings: general, upload rules, access rules and members. Storage and domain tabs arrive in PV7 and PV8. -->
<template>
  <AppShell>
    <template #title>{{ library ? library.name : "" }}</template>

    <el-skeleton v-if="loading" :rows="6" animated />
    <el-result v-else-if="!library" icon="warning" :title="$t('notFound.title')" :sub-title="$t('notFound.body')" />
    <template v-else>
      <div class="head">
        <h1>{{ library.name }}</h1>
        <el-tag>{{ $t(`members.roles.${library.myRole}`) }}</el-tag>
      </div>

      <el-tabs v-model="tab">
        <el-tab-pane :label="$t('settings.general')" name="general">
          <el-form label-position="top" class="pv-card form" :disabled="!isManager" @submit.prevent="save">
            <el-form-item :label="$t('library.name')"><el-input v-model="draft.name" maxlength="100" /></el-form-item>
            <el-form-item :label="$t('home.visibility')">
              <el-radio-group v-model="draft.visibilityDefault">
                <el-radio-button value="private">{{ $t("library.private") }}</el-radio-button>
                <el-radio-button value="public" :disabled="library && library.publicSharing === false">{{ $t("library.public") }}</el-radio-button>
              </el-radio-group>
              <div v-if="library && library.publicSharing === false" class="pv-muted small">{{ $t("library.sharingOff") }}</div>
            </el-form-item>
            <el-form-item><el-checkbox v-model="draft.everyoneInOrg">{{ $t("library.everyone") }}</el-checkbox></el-form-item>
            <el-form-item :label="$t('settings.moderation')">
              <el-select v-model="draft.moderationLevel">
                <el-option value="off" :label="$t('settings.moderationOff')" />
                <el-option value="standard" :label="$t('settings.moderationStandard')" />
                <el-option value="strict" :label="$t('settings.moderationStrict')" />
              </el-select>
            </el-form-item>
            <el-form-item :label="$t('settings.retention')">
              <el-input-number v-model="draft.retentionDays" :min="1" :max="3650" />
            </el-form-item>
            <div v-if="isManager" class="actions">
              <el-button type="primary" native-type="submit" :loading="busy">{{ $t("library.save") }}</el-button>
              <el-button type="danger" plain @click="archive">{{ $t("library.archive") }}</el-button>
            </div>
          </el-form>
        </el-tab-pane>

        <el-tab-pane :label="$t('settings.rules')" name="rules">
          <el-form label-position="top" class="pv-card form" :disabled="!isManager" @submit.prevent="save">
            <el-form-item :label="$t('settings.maxUpload')">
              <el-input-number v-model="draft.maxUploadMb" :min="1" :max="5120" :controls="false" placeholder="—" />
            </el-form-item>
            <el-form-item :label="$t('settings.allowedTypes')"><el-input v-model="draft.allowedTypes" type="textarea" :rows="3" /></el-form-item>
            <el-form-item :label="$t('settings.presets')"><el-input v-model="draft.transformPresets" type="textarea" :rows="3" /></el-form-item>
            <el-form-item><el-checkbox v-model="draft.randomApiEnabled" :disabled="library && library.publicSharing === false">{{ $t("settings.random") }}</el-checkbox></el-form-item>
            <el-button v-if="isManager" type="primary" native-type="submit" :loading="busy">{{ $t("library.save") }}</el-button>
          </el-form>
        </el-tab-pane>

        <el-tab-pane :label="$t('settings.access')" name="access">
          <el-form label-position="top" class="pv-card form" :disabled="!isManager" @submit.prevent="save">
            <el-form-item :label="$t('settings.referrers')"><el-input v-model="draft.allowedReferrers" type="textarea" :rows="3" /></el-form-item>
            <el-form-item :label="$t('settings.ipAllow')"><el-input v-model="draft.ipAllowList" type="textarea" :rows="3" /></el-form-item>
            <el-form-item :label="$t('settings.ipBlock')"><el-input v-model="draft.ipBlockList" type="textarea" :rows="3" /></el-form-item>
            <el-button v-if="isManager" type="primary" native-type="submit" :loading="busy">{{ $t("library.save") }}</el-button>
          </el-form>
        </el-tab-pane>

        <el-tab-pane v-if="canSeeMembers" :label="$t('settings.members')" name="members">
          <div class="pv-card">
            <el-table :data="members" :empty-text="'—'">
              <el-table-column :label="$t('members.title')" min-width="200">
                <template #default="{ row }">
                  <div>{{ row.email || row.principalId }}</div>
                  <div class="pv-muted small">{{ row.principalKind === "guest" ? $t("members.guest") : $t("members.member") }}</div>
                </template>
              </el-table-column>
              <el-table-column :label="$t('members.role')" width="180">
                <template #default="{ row }">
                  <el-select v-if="isManager" :model-value="row.role" size="small" @change="(r) => setRole(row.principalId, r)">
                    <el-option v-for="r in rolesFor(row.principalKind)" :key="r" :value="r" :label="$t(`members.roles.${r}`)" />
                  </el-select>
                  <span v-else>{{ $t(`members.roles.${row.role}`) }}</span>
                </template>
              </el-table-column>
              <el-table-column v-if="isManager" width="110">
                <template #default="{ row }">
                  <el-button size="small" text type="danger" @click="removeMember(row.principalId)">{{ $t("members.remove") }}</el-button>
                </template>
              </el-table-column>
            </el-table>
          </div>

          <div v-if="isManager" class="two">
            <el-form class="pv-card" label-position="top" @submit.prevent="addMember">
              <h3>{{ $t("members.add") }}</h3>
              <el-form-item :label="$t('members.pickMember')">
                <el-select v-model="add.principalId" filterable>
                  <el-option v-for="m in orgMembers" :key="m.subjectId" :value="m.subjectId" :label="m.subjectId" />
                </el-select>
              </el-form-item>
              <el-form-item :label="$t('members.role')">
                <el-select v-model="add.role"><el-option v-for="r in roles" :key="r" :value="r" :label="$t(`members.roles.${r}`)" /></el-select>
              </el-form-item>
              <el-button type="primary" native-type="submit" :disabled="!add.principalId">{{ $t("library.save") }}</el-button>
            </el-form>

            <el-form class="pv-card" label-position="top" @submit.prevent="inviteGuest">
              <h3>{{ $t("members.inviteGuest") }}</h3>
              <el-form-item :label="$t('members.guestEmail')"><el-input v-model="guest.email" type="email" /></el-form-item>
              <el-form-item :label="$t('members.role')">
                <el-select v-model="guest.role"><el-option v-for="r in guestRoles" :key="r" :value="r" :label="$t(`members.roles.${r}`)" /></el-select>
              </el-form-item>
              <el-button type="primary" native-type="submit" :disabled="!guest.email">{{ $t("members.invite") }}</el-button>
            </el-form>
          </div>

          <div v-if="isManager && invitations.length" class="pv-card">
            <h3>{{ $t("members.pending") }}</h3>
            <el-table :data="invitations">
              <el-table-column prop="email" :label="$t('members.guestEmail')" min-width="200" />
              <el-table-column :label="$t('members.role')" width="140">
                <template #default="{ row }">{{ $t(`members.roles.${row.role}`) }}</template>
              </el-table-column>
              <el-table-column width="110">
                <template #default="{ row }">
                  <el-button size="small" text type="danger" @click="revoke(row.id)">{{ $t("members.revoke") }}</el-button>
                </template>
              </el-table-column>
            </el-table>
          </div>
        </el-tab-pane>
      </el-tabs>
    </template>
  </AppShell>
</template>

<script>
import { ElMessage, ElMessageBox } from "element-plus";
import { api } from "@/api/client";
import AppShell from "@/components/AppShell.vue";

const lines = (s) =>
  String(s || "")
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean);

export default {
  name: "LibrarySettings",
  components: { AppShell },
  props: { org: { type: String, required: true }, lib: { type: String, required: true } },
  data: () => ({
    loading: true,
    busy: false,
    tab: "general",
    library: null,
    draft: {},
    members: [],
    invitations: [],
    orgMembers: [],
    add: { principalId: "", role: "viewer" },
    guest: { email: "", role: "viewer" },
    roles: ["manager", "editor", "uploader", "viewer"],
    guestRoles: ["uploader", "viewer"],
  }),
  computed: {
    isManager() {
      return this.library?.myRole === "manager";
    },
    canSeeMembers() {
      return ["manager", "editor", "viewer"].includes(this.library?.myRole);
    },
  },
  watch: {
    lib() {
      this.load();
    },
  },
  mounted() {
    this.load();
  },
  methods: {
    rolesFor(kind) {
      return kind === "guest" ? this.guestRoles : this.roles;
    },
    toDraft(l) {
      const s = l.settings;
      this.draft = {
        name: l.name,
        visibilityDefault: l.visibilityDefault,
        everyoneInOrg: l.everyoneInOrg,
        moderationLevel: l.moderationLevel,
        retentionDays: l.retentionDays,
        maxUploadMb: s.maxUploadBytes ? Math.round(s.maxUploadBytes / 1048576) : undefined,
        allowedTypes: s.allowedTypes.join("\n"),
        transformPresets: s.transformPresets.join("\n"),
        randomApiEnabled: s.randomApiEnabled,
        allowedReferrers: s.allowedReferrers.join("\n"),
        ipAllowList: s.ipAllowList.join("\n"),
        ipBlockList: s.ipBlockList.join("\n"),
      };
    },
    async load() {
      this.loading = true;
      try {
        const r = await api.libraries.get(this.org, this.lib);
        this.library = r.library;
        this.toDraft(r.library);
        await this.loadMembers();
      } catch {
        this.library = null;
      } finally {
        this.loading = false;
      }
    },
    async loadMembers() {
      if (!this.canSeeMembers) return;
      const m = await api.libraries.members(this.org, this.lib);
      this.members = m.members;
      this.invitations = m.invitations;
      if (this.isManager) {
        const om = await api.orgs.members(this.org).catch(() => ({ members: [] }));
        this.orgMembers = om.members ?? [];
      }
    },
    async save() {
      this.busy = true;
      const d = this.draft;
      try {
        const r = await api.libraries.update(this.org, this.lib, {
          name: d.name.trim(),
          visibilityDefault: d.visibilityDefault,
          everyoneInOrg: d.everyoneInOrg,
          moderationLevel: d.moderationLevel,
          retentionDays: d.retentionDays,
          settings: {
            maxUploadBytes: d.maxUploadMb ? d.maxUploadMb * 1048576 : null,
            allowedTypes: lines(d.allowedTypes),
            transformPresets: lines(d.transformPresets),
            randomApiEnabled: !!d.randomApiEnabled,
            allowedReferrers: lines(d.allowedReferrers),
            ipAllowList: lines(d.ipAllowList),
            ipBlockList: lines(d.ipBlockList),
          },
        });
        this.library = r.library;
        this.toDraft(r.library);
        await this.$store.dispatch("loadLibraries");
        ElMessage.success(this.$t("library.saved"));
      } catch (e) {
        ElMessage.error(e.message || this.$t("errors.generic"));
      } finally {
        this.busy = false;
      }
    },
    async archive() {
      try {
        await ElMessageBox.confirm(this.$t("library.archiveConfirm", { name: this.library.name }), { type: "warning" });
      } catch {
        return;
      }
      try {
        await api.libraries.archive(this.org, this.lib);
        await this.$store.dispatch("loadLibraries");
        ElMessage.success(this.$t("library.archived"));
        this.$router.push({ name: "home" });
      } catch (e) {
        ElMessage.error(e.message || this.$t("errors.generic"));
      }
    },
    async run(fn) {
      try {
        await fn();
        await this.loadMembers();
      } catch (e) {
        ElMessage.error(e.message || this.$t("errors.generic"));
      }
    },
    setRole(principalId, role) {
      return this.run(() => api.libraries.putMember(this.org, this.lib, principalId, role));
    },
    removeMember(principalId) {
      return this.run(() => api.libraries.removeMember(this.org, this.lib, principalId));
    },
    addMember() {
      return this.run(async () => {
        await api.libraries.putMember(this.org, this.lib, this.add.principalId, this.add.role);
        this.add.principalId = "";
      });
    },
    inviteGuest() {
      return this.run(async () => {
        const email = this.guest.email.trim();
        await api.libraries.invite(this.org, this.lib, email, this.guest.role);
        ElMessage.success(this.$t("members.invited", { email }));
        this.guest.email = "";
      });
    },
    revoke(id) {
      return this.run(() => api.libraries.revokeInvitation(this.org, this.lib, id));
    },
  },
};
</script>

<style scoped>
.head {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 8px;
}
h1 {
  font-size: 1.5rem;
  margin: 0;
}
h3 {
  margin-top: 0;
}
.form {
  max-width: 640px;
}
.actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.two {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 16px;
  margin: 16px 0;
}
.small {
  font-size: 0.8rem;
}
.pv-card + .pv-card {
  margin-top: 16px;
}
</style>
