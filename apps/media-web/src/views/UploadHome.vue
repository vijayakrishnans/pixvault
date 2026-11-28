<!-- Derived from MarSeventh/Sanyue-ImgHub@1621525:src/views/UploadHome.vue (MIT), modified.
     Kept: the drop zone, paste-to-upload and the per-file progress queue. Replaced: the channel picker and
     single-request upload with library uploads (hashed in the browser, resumable parts, verified on commit),
     and the page becomes the library browser (PV5): a folder tree, search and filters, grid and list views, a
     bulk bar, the file drawer, folder uploads, and live updates and presence from teammates. -->
<template>
  <AppShell>
    <template #title>{{ library ? library.name : "" }}</template>

    <el-skeleton v-if="loading" :rows="6" animated />
    <el-result v-else-if="!library" icon="warning" :title="$t('notFound.title')" :sub-title="$t('notFound.body')" />
    <template v-else>
      <div class="head">
        <h1>{{ library.name }}</h1>
        <el-tag>{{ $t(`members.roles.${library.myRole}`) }}</el-tag>
        <span class="grow" />
        <div v-if="others.length" class="presence" data-test="presence" :aria-label="$t('browse.here', { n: others.length })">
          <el-tooltip v-for="u in others.slice(0, 5)" :key="u.sub" :content="presenceLabel(u)" placement="bottom">
            <span class="avatar">{{ initials(names[u.sub] || u.sub) }}</span>
          </el-tooltip>
          <span v-if="others.length > 5" class="avatar more">+{{ others.length - 5 }}</span>
        </div>
        <el-tooltip :content="$t(`browse.live.${liveState}`)" placement="bottom">
          <span class="live-dot" :class="liveState" data-test="live-state" :data-state="liveState" />
        </el-tooltip>
        <router-link :to="{ name: 'librarySettings', params: { org, lib } }"><el-button>{{ $t("nav.settings") }}</el-button></router-link>
      </div>

      <div v-if="usage" class="usage pv-muted">
        <span>{{ $t("upload.usage", { used: fmt(usage.storageBytes), limit: fmt(usage.storageBytesLimit) }) }}</span>
        <el-progress :percentage="usagePct" :status="usagePct >= 100 ? 'exception' : usagePct >= 80 ? 'warning' : ''" :stroke-width="8" />
      </div>

      <section
        v-if="canUpload"
        class="drop pv-card"
        :class="{ over: dragging }"
        tabindex="0"
        role="button"
        :aria-label="$t('upload.drop')"
        @click="$refs.picker.click()"
        @keydown.enter.prevent="$refs.picker.click()"
        @dragover.prevent="dragging = true"
        @dragleave.prevent="dragging = false"
        @drop.prevent="onDrop"
      >
        <el-icon class="drop-icon"><Upload /></el-icon>
        <div class="drop-title">{{ $t("upload.drop") }}</div>
        <div class="pv-muted">{{ $t("browse.dropHint", { folder: uploadFolder }) }}</div>
        <input ref="picker" type="file" multiple hidden @change="onPick" />
        <input ref="folderPicker" type="file" webkitdirectory multiple hidden data-test="folder-picker" @change="onPickFolder" />
      </section>

      <div v-if="canUpload" class="opts">
        <el-button size="small" data-test="upload-folder" @click="$refs.folderPicker.click()"><el-icon><FolderAdd /></el-icon><span class="btn-label">{{ $t("browse.uploadFolder") }}</span></el-button>
        <el-radio-group v-if="publicSharing" v-model="visibility" size="small">
          <el-radio-button value="private">{{ $t("library.private") }}</el-radio-button>
          <el-radio-button value="public">{{ $t("library.public") }}</el-radio-button>
        </el-radio-group>
        <span v-else class="pv-muted small" data-test="sharing-off">{{ $t("library.sharingOff") }}</span>
      </div>

      <ul v-if="queue.length" class="queue" aria-live="polite">
        <li v-for="q in queue.slice(0, 50)" :key="q.key" class="pv-card item">
          <div class="item-top">
            <span class="item-name">{{ q.folder !== "/" ? `${q.folder}/` : "" }}{{ q.file.name }}</span>
            <span class="pv-muted">{{ fmt(q.file.size) }}</span>
          </div>
          <el-progress :percentage="Math.round(q.progress * 100)" :status="q.error ? 'exception' : q.phase === 'done' ? 'success' : ''" />
          <div class="item-status pv-muted">
            <span v-if="q.error">{{ q.error }}</span>
            <span v-else>{{ $t(`upload.phase.${q.phase}`) }}<span v-if="q.resumed"> · {{ $t("upload.resumed") }}</span><span v-if="q.dedup"> · {{ $t("upload.dedup") }}</span></span>
            <el-button v-if="q.conflict" size="small" text type="primary" @click="start(q, true)">{{ $t("upload.replace") }}</el-button>
            <el-button v-if="q.error && !q.conflict" size="small" text type="primary" @click="start(q)">{{ $t("upload.retry") }}</el-button>
            <el-button v-if="q.phase === 'done' && q.fileId" size="small" text type="primary" @click="openUploaded(q)">{{ $t("links.open") }}</el-button>
          </div>
        </li>
        <li v-if="queue.length > 50" class="pv-muted small">{{ $t("browse.moreInQueue", { n: queue.length - 50 }) }}</li>
      </ul>

      <el-tabs v-model="tab" class="tabs" @tab-change="onTab">
        <el-tab-pane :label="$t('upload.files')" name="files" />
        <el-tab-pane v-if="canTrash" :label="$t('review.tab')" name="review" />
        <el-tab-pane v-if="canTrash" :label="$t('upload.trash')" name="trash" />
      </el-tabs>

      <div v-if="tab === 'files'" class="browser">
        <aside class="tree pv-card" :class="{ open: treeOpen }">
          <div class="tree-head">
            <strong>{{ $t("browse.folders") }}</strong>
            <el-button v-if="canUpload" size="small" text data-test="new-folder" :aria-label="$t('browse.newFolder')" @click="newFolder"><el-icon><FolderAdd /></el-icon></el-button>
          </div>
          <el-tree
            :data="tree"
            node-key="key"
            :props="{ label: 'label', children: 'children' }"
            :default-expanded-keys="expandedKeys"
            :current-node-key="folder ?? '*'"
            :expand-on-click-node="false"
            highlight-current
            data-test="folder-tree"
            @node-click="openFolder"
          >
            <template #default="{ data }">
              <span class="tree-node" :data-path="data.path ?? '*'">
                <el-icon><Folder /></el-icon>
                <span class="tree-label">{{ data.label }}</span>
                <span v-if="data.files" class="pv-muted small">{{ data.files }}</span>
              </span>
            </template>
          </el-tree>
        </aside>

        <main class="main">
          <div class="crumbs">
            <el-button class="tree-toggle" size="small" text :aria-label="$t('browse.folders')" @click="treeOpen = !treeOpen"><el-icon><Folder /></el-icon></el-button>
            <el-breadcrumb separator="/">
              <el-breadcrumb-item><a href="#" @click.prevent="openFolder({ path: null })">{{ $t("browse.allFiles") }}</a></el-breadcrumb-item>
              <el-breadcrumb-item v-for="c in crumbs" :key="c.path"><a href="#" @click.prevent="openFolder({ path: c.path })">{{ c.label }}</a></el-breadcrumb-item>
            </el-breadcrumb>
            <span class="grow" />
            <template v-if="folder && folder !== '/' && canEdit">
              <el-button size="small" text data-test="folder-rename" @click="renameFolder">{{ $t("browse.rename") }}</el-button>
              <el-button size="small" text data-test="folder-move" @click="moveTarget = { kind: 'folder', from: folder }">{{ $t("browse.move") }}</el-button>
              <el-button v-if="canTrash" size="small" text type="danger" data-test="folder-trash" @click="trashFolder">{{ $t("upload.delete") }}</el-button>
            </template>
          </div>

          <div class="toolbar">
            <el-input v-model="q" class="search" clearable :placeholder="$t('browse.search')" data-test="search" @input="onSearch" @clear="onSearch">
              <template #prefix><el-icon><Search /></el-icon></template>
            </el-input>
            <el-select v-model="filters.type" clearable :placeholder="$t('browse.type')" class="filter" data-test="filter-type" @change="reload">
              <el-option v-for="t in types" :key="t" :value="t" :label="$t(`browse.types.${t}`)" />
            </el-select>
            <el-select v-if="tags.length" v-model="filters.tag" clearable filterable :placeholder="$t('browse.tag')" class="filter" data-test="filter-tag" @change="reload">
              <el-option v-for="t in tags" :key="t.tag" :value="t.tag" :label="`${t.tag} (${t.files})`" />
            </el-select>
            <el-select v-model="filters.visibility" clearable :placeholder="$t('browse.visibility')" class="filter" @change="reload">
              <el-option value="public" :label="$t('library.public')" />
              <el-option value="private" :label="$t('library.private')" />
            </el-select>
            <el-select v-model="filters.status" clearable :placeholder="$t('browse.state')" class="filter" @change="reload">
              <el-option v-for="s in statuses" :key="s" :value="s" :label="$t(`status.${s}`)" />
            </el-select>
            <span class="grow" />
            <el-radio-group v-model="view" size="small" :aria-label="$t('browse.view')" @change="saveView">
              <el-radio-button value="grid" data-test="view-grid" :aria-label="$t('browse.grid')"><el-icon><Grid /></el-icon></el-radio-button>
              <el-radio-button value="list" data-test="view-list" :aria-label="$t('browse.list')"><el-icon><List /></el-icon></el-radio-button>
            </el-radio-group>
          </div>

          <div v-if="(canEdit || canTrash) && files.length" class="select-all">
            <el-checkbox :model-value="allSelected" :indeterminate="selected.length > 0 && !allSelected" data-test="select-all" @change="toggleAll">{{ $t("browse.selectAll") }}</el-checkbox>
            <span v-if="filtered && folder === null" class="pv-muted small">{{ $t("browse.searchingAll") }}</span>
          </div>

          <div v-loading="filesLoading">
            <el-empty v-if="!files.length && !filesLoading" :description="filtered ? $t('browse.noMatches') : $t('upload.empty')" />
            <div v-else-if="view === 'grid'" class="grid" data-test="grid">
              <FileCard v-for="f in files" :key="f.id" :file="f" :selectable="canEdit || canTrash" :selected="selectedSet.has(f.id)" @open="drawerFile = $event" @toggle="toggle" />
            </div>
            <el-table v-else :data="files" row-key="id" data-test="list" @selection-change="onTableSelection" @row-click="(row) => (drawerFile = row)">
              <el-table-column v-if="canEdit || canTrash" type="selection" width="40" />
              <el-table-column :label="$t('upload.name')" min-width="220">
                <template #default="{ row }">
                  <div class="fname">
                    {{ row.name }}
                    <el-tag v-if="row.status === 'public'" size="small" type="success">{{ $t("links.public") }}</el-tag>
                    <el-tag v-else-if="statusTag(row)" size="small" :type="statusTag(row).type" :data-test="`status-${row.status}`">{{ $t(`status.${row.status}`) }}</el-tag>
                  </div>
                  <div v-if="row.tags && row.tags.length" class="pv-muted small tags">{{ row.tags.join(" · ") }}</div>
                  <div class="pv-muted small">{{ row.folder }}</div>
                </template>
              </el-table-column>
              <el-table-column :label="$t('upload.size')" width="100">
                <template #default="{ row }">{{ fmt(row.size) }}</template>
              </el-table-column>
              <el-table-column :label="$t('upload.uploaded')" width="170">
                <template #default="{ row }">{{ new Date(row.createdAt).toLocaleString() }}</template>
              </el-table-column>
            </el-table>
          </div>
          <div v-if="nextCursor" class="more"><el-button @click="loadFiles(true)">{{ $t("upload.more") }}</el-button></div>
          <BatchActionBar :selected-count="selected.length" :can-edit="canEdit" :can-publish="publicSharing" :can-trash="canTrash" @clear="selected = []" @action="bulk" />
        </main>
      </div>

      <template v-else>
        <el-alert v-if="tab === 'review'" type="info" :closable="false" show-icon :title="$t('review.hint')" class="review-hint" />
        <el-table v-loading="filesLoading" :data="files" :empty-text="tab === 'trash' ? $t('upload.trashEmpty') : $t('review.empty')">
          <el-table-column :label="$t('upload.name')" min-width="220">
            <template #default="{ row }">
              <div class="fname">
                {{ row.name }}
                <el-tag v-if="statusTag(row)" size="small" :type="statusTag(row).type" :data-test="`status-${row.status}`">{{ $t(`status.${row.status}`) }}</el-tag>
              </div>
              <div v-if="tab === 'review' && row.pipelineNote" class="pv-muted small">{{ reasonText(row) }}</div>
              <div class="pv-muted small">{{ row.folder }}</div>
            </template>
          </el-table-column>
          <el-table-column :label="$t('upload.size')" width="110">
            <template #default="{ row }">{{ fmt(row.size) }}</template>
          </el-table-column>
          <el-table-column :label="tab === 'trash' ? $t('upload.trashed') : $t('upload.uploaded')" width="170">
            <template #default="{ row }">{{ new Date(tab === "trash" ? row.trashedAt : row.createdAt).toLocaleString() }}</template>
          </el-table-column>
          <el-table-column width="250" align="right">
            <template #default="{ row }">
              <template v-if="tab === 'review'">
                <el-button v-if="isFailed(row)" size="small" text type="primary" data-test="reprocess" @click="reprocess(row)">{{ $t("review.reprocess") }}</el-button>
                <el-button v-else size="small" text type="primary" data-test="approve" @click="decide(row, 'approve')">{{ $t("review.approve") }}</el-button>
                <el-button size="small" text type="danger" data-test="reject" @click="decide(row, 'reject')">{{ $t("review.reject") }}</el-button>
              </template>
              <template v-else>
                <el-button size="small" text type="primary" @click="restore(row)">{{ $t("upload.restore") }}</el-button>
                <el-button size="small" text type="danger" @click="purge(row)">{{ $t("upload.purge") }}</el-button>
              </template>
            </template>
          </el-table-column>
        </el-table>
        <div v-if="nextCursor" class="more"><el-button @click="loadFiles(true)">{{ $t("upload.more") }}</el-button></div>
      </template>

      <FileDetailDialog
        :file="drawerFile"
        :org="org"
        :lib="lib"
        :can-edit="canEdit"
        :can-trash="canTrash"
        :names="names"
        @close="drawerFile = null"
        @links="linkFile = $event"
        @download="download"
        @move="moveTarget = { kind: 'files', ids: [$event.id], from: $event.folder }"
        @trash="trash"
        @updated="onFileUpdated"
      />
      <LinkDialog :file="linkFile" :org="org" :lib="lib" :can-edit="canEdit && publicSharing" @close="linkFile = null" @updated="onFileUpdated" />
      <MoveFileDialog :visible="!!moveTarget" :title="moveTitle" :folders="folders" :current="moveTarget ? moveTarget.from : '/'" :busy="moving" @close="moveTarget = null" @confirm="doMove" />
    </template>
  </AppShell>
</template>

<script>
import { ElMessage, ElMessageBox } from "element-plus";
import { api } from "@/api/client";
import { uploadFile } from "@/api/uploader";
import AppShell from "@/components/AppShell.vue";
import LinkDialog from "@/components/LinkDialog.vue";
import BatchActionBar from "@/components/dashboard/BatchActionBar.vue";
import FileCard from "@/components/dashboard/FileCard.vue";
import FileDetailDialog from "@/components/dashboard/FileDetailDialog.vue";
import MoveFileDialog from "@/components/dashboard/MoveFileDialog.vue";
import { buildTree, crumbs as crumbsOf } from "@/utils/folders";
import { filesFromDrop, folderForRelativePath, joinFolder } from "@/utils/upload/directoryTraversal";
import { changeTouchesView, initials } from "@/utils/browse";
import { createLive, debounce } from "@/utils/live";

const UNITS = ["B", "KB", "MB", "GB", "TB"];
const VIEW_KEY = "pixvault.media.view";
const PARALLEL_UPLOADS = 3;
let seq = 0;

function savedView() {
  try {
    return globalThis.localStorage?.getItem(VIEW_KEY) === "list" ? "list" : "grid";
  } catch {
    return "grid";
  }
}

export default {
  name: "LibraryHome",
  components: { AppShell, LinkDialog, BatchActionBar, FileCard, FileDetailDialog, MoveFileDialog },
  props: { org: { type: String, required: true }, lib: { type: String, required: true } },
  data: () => ({
    loading: true,
    library: null,
    usage: null,
    dragging: false,
    visibility: "private",
    queue: [],
    active: 0,
    tab: "files",
    files: [],
    nextCursor: null,
    filesLoading: false,
    linkFile: null,
    drawerFile: null,
    pollTimer: null,
    pollUntil: 0,
    folder: null,
    folders: [],
    tags: [],
    q: "",
    filters: { type: "", tag: "", visibility: "", status: "" },
    view: savedView(),
    selected: [],
    moveTarget: null,
    moving: false,
    treeOpen: false,
    types: ["image", "video", "audio", "document", "other"],
    statuses: ["public", "private", "processing", "held", "flagged", "removed"],
    live: null,
    liveState: "connecting",
    presence: [],
    names: {},
    namesAt: 0,
    searchTimer: null,
    loadSeq: 0,
  }),
  computed: {
    canUpload() {
      return ["manager", "editor", "uploader"].includes(this.library?.myRole);
    },
    canTrash() {
      return ["manager", "editor"].includes(this.library?.myRole);
    },
    canEdit() {
      return ["manager", "editor"].includes(this.library?.myRole);
    },
    /** Off in prod until CSAM scanning and the domain exist: files stay private, signed links work. */
    publicSharing() {
      return this.library?.publicSharing !== false;
    },
    usagePct() {
      if (!this.usage) return 0;
      return Math.min(100, Math.round((this.usage.storageBytes / this.usage.storageBytesLimit) * 100));
    },
    uploadFolder() {
      return this.folder ?? "/";
    },
    tree() {
      const keyed = (n) => ({ ...n, key: n.path ?? "*", children: n.children.map(keyed) });
      return buildTree(this.folders, this.$t("browse.allFiles")).map(keyed);
    },
    expandedKeys() {
      return ["*", ...crumbsOf(this.folder).map((c) => c.path)];
    },
    crumbs() {
      return this.folder ? crumbsOf(this.folder) : [];
    },
    filtered() {
      return !!(this.q.trim() || this.filters.type || this.filters.tag || this.filters.visibility || this.filters.status);
    },
    selectedSet() {
      return new Set(this.selected);
    },
    allSelected() {
      return this.files.length > 0 && this.files.every((f) => this.selectedSet.has(f.id));
    },
    me() {
      return this.$store.state.user?.id ?? null;
    },
    others() {
      return this.presence.filter((u) => u.sub !== this.me);
    },
    moveTitle() {
      if (!this.moveTarget) return "";
      if (this.moveTarget.kind === "folder") return this.$t("browse.moveFolderTitle", { folder: this.moveTarget.from });
      return this.$t("browse.moveTitle", { n: this.moveTarget.ids.length });
    },
  },
  watch: {
    lib() {
      this.stopLive();
      this.folder = null;
      this.load();
    },
    folder(f) {
      this.live?.where(f ?? "/");
    },
  },
  mounted() {
    this.load();
    window.addEventListener("paste", this.onPaste);
  },
  beforeUnmount() {
    window.removeEventListener("paste", this.onPaste);
    clearTimeout(this.pollTimer);
    clearTimeout(this.searchTimer);
    this.stopLive();
  },
  methods: {
    initials,
    fmt(n) {
      let i = 0;
      let v = n;
      while (v >= 1024 && i < UNITS.length - 1) {
        v /= 1024;
        i++;
      }
      return `${v < 10 && i ? v.toFixed(1) : Math.round(v)} ${UNITS[i]}`;
    },
    async load() {
      this.loading = true;
      try {
        const r = await api.libraries.get(this.org, this.lib);
        this.library = r.library;
        this.visibility = r.library.publicSharing === false ? "private" : r.library.visibilityDefault;
        await Promise.all([this.loadFiles(), this.loadUsage(), this.loadFolders(), this.loadTags(), this.loadNames()]);
        this.startLive();
      } catch {
        this.library = null;
      } finally {
        this.loading = false;
      }
    },
    async loadUsage() {
      this.usage = (await api.libraries.usage(this.org).catch(() => null))?.usage ?? null;
    },
    async loadFolders() {
      this.folders = (await api.libraries.folders(this.org, this.lib).catch(() => null))?.folders ?? [];
    },
    async loadTags() {
      this.tags = (await api.libraries.tags(this.org, this.lib).catch(() => null))?.tags ?? [];
    },
    async loadNames() {
      const r = await api.libraries.members(this.org, this.lib).catch(() => null);
      const names = {};
      for (const m of r?.members ?? []) if (m.email) names[m.principalId] = m.email;
      const me = this.$store.state.user;
      if (me?.id) names[me.id] = me.email ?? this.$t("browse.you");
      this.names = names;
      this.namesAt = Date.now();
    },
    query(more) {
      const cursor = more ? this.nextCursor : undefined;
      if (this.tab !== "files") return { trash: this.tab === "trash", review: this.tab === "review", cursor };
      // Search and filters look across the whole library unless a folder is open.
      return {
        folder: this.folder ?? undefined,
        q: this.q,
        type: this.filters.type || undefined,
        tag: this.filters.tag || undefined,
        visibility: this.filters.visibility || undefined,
        status: this.filters.status || undefined,
        cursor,
      };
    },
    async loadFiles(more = false) {
      if (more !== true) more = false;
      const mine = ++this.loadSeq;
      this.filesLoading = true;
      try {
        const r = await api.libraries.files(this.org, this.lib, this.query(more));
        if (mine !== this.loadSeq) return; // a newer load started meanwhile
        this.files = more ? [...this.files, ...r.files] : r.files;
        this.nextCursor = r.nextCursor;
        if (!more) this.selected = this.selected.filter((id) => this.files.some((f) => f.id === id));
        this.schedulePoll();
      } catch (e) {
        if (mine !== this.loadSeq) return;
        if (e?.status !== 404) ElMessage.error(e.message || this.$t("errors.generic"));
        this.files = [];
      } finally {
        if (mine === this.loadSeq) this.filesLoading = false;
      }
    },
    reload() {
      this.selected = [];
      return this.loadFiles();
    },
    onTab() {
      this.selected = [];
      this.loadFiles();
    },
    onSearch() {
      clearTimeout(this.searchTimer);
      this.searchTimer = setTimeout(() => this.reload(), 250);
    },
    openFolder(node) {
      this.folder = node?.path ?? null;
      this.treeOpen = false;
      this.reload();
    },
    saveView() {
      try {
        globalThis.localStorage?.setItem(VIEW_KEY, this.view);
      } catch {
        /* the choice lasts for this visit */
      }
    },

    // ── live ───────────────────────────────────────────────
    startLive() {
      if (this.live || typeof WebSocket === "undefined") return;
      this.live = createLive({
        base: api.base,
        getTicket: () => api.libraries.liveTicket(this.org, this.lib),
        onChange: debounce((changes) => this.onLiveChanges(changes), 250, 1000),
        onPresence: (users) => {
          this.presence = users;
          // Someone who joined after the page loaded: fetch the member list again to show their name.
          if (users.some((u) => !this.names[u.sub]) && Date.now() - this.namesAt > 10_000) this.loadNames();
        },
        onState: (s) => (this.liveState = s),
      });
      this.live.where(this.folder ?? "/");
    },
    stopLive() {
      this.live?.stop();
      this.live = null;
      this.presence = [];
    },
    async onLiveChanges(changes) {
      const ctx = { folder: this.folder, listedIds: new Set(this.files.map((f) => f.id)), filtered: this.filtered || this.tab !== "files" };
      if (changes.some((c) => c.tree)) this.loadFolders();
      if (changes.some((c) => changeTouchesView(c, ctx))) await this.loadFiles();
      if (changes.some((c) => c.op === "processed")) this.loadTags();
      const open = this.drawerFile;
      if (open && changes.some((c) => c.files.some((f) => f.id === open.id))) {
        const r = await api.libraries.file(this.org, this.lib, open.id).catch(() => null);
        if (this.drawerFile?.id === open.id) this.drawerFile = r?.file && r.file.status !== "trashed" ? r.file : null;
      }
    },
    presenceLabel(u) {
      const who = this.names[u.sub] ?? this.$t("browse.someone");
      return u.folder ? this.$t("browse.inFolder", { who, folder: u.folder }) : who;
    },

    // ── uploads ────────────────────────────────────────────
    enqueue(items) {
      for (const { file, folder } of items) {
        this.queue.unshift({ key: ++seq, file, folder, phase: "queued", progress: 0, error: "", conflict: false, resumed: false, dedup: false, fileId: null, started: false });
      }
      this.pump();
    },
    pump() {
      // A dropped folder can hold hundreds of files: upload a few at a time, oldest first.
      while (this.active < PARALLEL_UPLOADS) {
        const next = [...this.queue].reverse().find((q) => !q.started);
        if (!next) return;
        this.active++;
        this.start(next).finally(() => {
          this.active--;
          this.pump();
        });
      }
    },
    async start(q, replace = false) {
      q.started = true;
      q.error = "";
      q.conflict = false;
      try {
        const r = await uploadFile({
          org: this.org,
          lib: this.lib,
          file: q.file,
          folder: q.folder,
          visibility: this.visibility,
          replace,
          onStatus: (s) => {
            q.phase = s.phase;
            if (typeof s.progress === "number") q.progress = s.phase === "hashing" ? s.progress * 0.1 : s.phase === "uploading" ? 0.1 + s.progress * 0.9 : s.progress;
          },
        });
        q.resumed = r.resumed;
        q.dedup = r.deduplicated;
        q.fileId = r.file?.id ?? null;
        q.progress = 1;
        q.phase = "done";
        this.pollUntil = 0; // a new upload gets its own two minutes of refreshes while it processes
        // With a live connection the change event refreshes the view; without one, refresh here.
        if (this.liveState !== "open") await Promise.all([this.loadFiles(), this.loadFolders()]);
        this.loadUsage();
      } catch (e) {
        q.conflict = e?.status === 409 && e?.code === "conflict";
        q.error = q.conflict ? this.$t("upload.exists") : e?.code === "quota_exceeded" ? e.message : e?.message || this.$t("errors.generic");
      }
    },
    async onDrop(e) {
      this.dragging = false;
      const items = e.dataTransfer?.items;
      if (items && [...items].some((i) => typeof i.webkitGetAsEntry === "function")) {
        const r = await filesFromDrop(items, this.uploadFolder);
        if (r.truncated) ElMessage.warning(this.$t("browse.folderTooBig", { n: r.items.length }));
        if (r.items.length) this.enqueue(r.items);
        return;
      }
      if (e.dataTransfer?.files?.length) this.enqueue([...e.dataTransfer.files].map((file) => ({ file, folder: this.uploadFolder })));
    },
    onPick(e) {
      if (e.target.files?.length) this.enqueue([...e.target.files].map((file) => ({ file, folder: this.uploadFolder })));
      e.target.value = "";
    },
    onPickFolder(e) {
      const files = [...(e.target.files ?? [])].filter((f) => !f.webkitRelativePath.split("/").some((p) => p.startsWith(".")));
      if (files.length) this.enqueue(files.map((file) => ({ file, folder: folderForRelativePath(this.uploadFolder, file.webkitRelativePath) })));
      e.target.value = "";
    },
    onPaste(e) {
      if (!this.canUpload) return;
      const files = [...(e.clipboardData?.files ?? [])];
      if (!files.length) return;
      // Pasted screenshots are all called "image.png": give each a unique, dated name.
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      this.enqueue(files.map((f, i) => ({ file: f.name === "image.png" ? new File([f], `paste-${stamp}-${i}.png`, { type: f.type }) : f, folder: this.uploadFolder })));
    },
    async openUploaded(q) {
      const r = await api.libraries.file(this.org, this.lib, q.fileId).catch(() => null);
      if (r?.file) this.linkFile = r.file;
    },

    // ── selection and bulk actions ─────────────────────────
    toggle(file) {
      this.selected = this.selectedSet.has(file.id) ? this.selected.filter((id) => id !== file.id) : [...this.selected, file.id];
    },
    toggleAll(on) {
      this.selected = on ? this.files.map((f) => f.id) : [];
    },
    onTableSelection(rows) {
      this.selected = rows.map((r) => r.id);
    },
    async bulk(action) {
      const ids = [...this.selected];
      if (!ids.length) return;
      if (action === "move") {
        this.moveTarget = { kind: "files", ids, from: this.folder ?? "/" };
        return;
      }
      if (action === "trash") {
        try {
          await ElMessageBox.confirm(this.$t("browse.trashConfirm", { n: ids.length }), { type: "warning" });
        } catch {
          return;
        }
      }
      const body = action === "trash" ? { action: "trash", ids } : { action: "visibility", ids, visibility: action };
      await this.runBatch(body, action === "trash" ? "browse.trashedN" : "browse.updatedN");
    },
    async runBatch(body, doneKey) {
      try {
        const r = await api.libraries.batch(this.org, this.lib, body);
        if (r.failed.length) ElMessage.warning(this.$t("browse.partly", { done: r.done, failed: r.failed.length }));
        else ElMessage.success(this.$t(doneKey, { n: r.done }));
        this.selected = [];
        await Promise.all([this.loadFiles(), this.loadFolders()]);
        return r;
      } catch (e) {
        ElMessage.error(e.message || this.$t("errors.generic"));
        return null;
      }
    },
    async doMove(target) {
      const t = this.moveTarget;
      if (!t) return;
      this.moving = true;
      try {
        if (t.kind === "folder") {
          const to = joinFolder(target, t.from.split("/").pop());
          await api.libraries.moveFolder(this.org, this.lib, t.from, to);
          ElMessage.success(this.$t("browse.folderMoved", { folder: to }));
          this.folder = to;
          await Promise.all([this.loadFolders(), this.loadFiles()]);
        } else {
          const r = await this.runBatch({ action: "move", ids: t.ids, folder: target }, "browse.movedN");
          if (r && this.drawerFile && t.ids.includes(this.drawerFile.id)) this.drawerFile = r.files?.find((f) => f.id === this.drawerFile.id) ?? null;
        }
        this.moveTarget = null;
      } catch (e) {
        ElMessage.error(e?.status === 409 ? this.$t("browse.folderExists") : e.message || this.$t("errors.generic"));
      } finally {
        this.moving = false;
      }
    },

    // ── folders ────────────────────────────────────────────
    async promptName(title, value = "") {
      try {
        const { value: v } = await ElMessageBox.prompt(title, { inputValue: value, inputPattern: /^[^/\u0000-\u001f]{1,255}$/, inputErrorMessage: this.$t("browse.badName") });
        return v.trim();
      } catch {
        return null;
      }
    },
    async newFolder() {
      const name = await this.promptName(this.$t("browse.newFolder"));
      if (!name) return;
      const path = joinFolder(this.folder ?? "/", name);
      try {
        await api.libraries.createFolder(this.org, this.lib, path);
        await this.loadFolders();
        this.openFolder({ path });
      } catch (e) {
        ElMessage.error(e.message || this.$t("errors.generic"));
      }
    },
    async renameFolder() {
      const from = this.folder;
      const old = from.split("/").pop();
      const name = await this.promptName(this.$t("browse.renameFolder"), old);
      if (!name || name === old) return;
      const to = joinFolder(from.split("/").slice(0, -1).join("/") || "/", name);
      try {
        await api.libraries.moveFolder(this.org, this.lib, from, to);
        this.folder = to;
        await Promise.all([this.loadFolders(), this.loadFiles()]);
      } catch (e) {
        ElMessage.error(e?.status === 409 ? this.$t("browse.folderExists") : e.message || this.$t("errors.generic"));
      }
    },
    async trashFolder() {
      const path = this.folder;
      try {
        await ElMessageBox.confirm(this.$t("browse.trashFolderConfirm", { folder: path }), { type: "warning" });
      } catch {
        return;
      }
      try {
        const r = await api.libraries.trashFolder(this.org, this.lib, path);
        ElMessage.success(this.$t("browse.trashedN", { n: r.trashed }));
        this.folder = path.split("/").slice(0, -1).join("/") || null;
        await Promise.all([this.loadFolders(), this.loadFiles()]);
      } catch (e) {
        ElMessage.error(e.message || this.$t("errors.generic"));
      }
    },

    // ── single files, review and trash ─────────────────────
    onFileUpdated(file) {
      this.files = this.files.map((f) => (f.id === file.id ? file : f));
      if (this.linkFile?.id === file.id) this.linkFile = file;
      if (this.drawerFile?.id === file.id) this.drawerFile = file;
    },
    statusTag(row) {
      return { processing: { type: "info" }, held: { type: "warning" }, flagged: { type: "danger" }, removed: { type: "danger" } }[row.status] ?? null;
    },
    isFailed(row) {
      return (row.pipelineNote ?? "").startsWith("failed:");
    },
    reasonText(row) {
      const n = row.pipelineNote ?? "";
      if (n.startsWith("flagged:")) return this.$t("review.reason.flagged", { categories: n.slice(8).split(",").join(", ") });
      if (n.startsWith("failed:")) return this.$t("review.reason.failed");
      if (n === "moderation_unavailable") return this.$t("review.reason.unavailable");
      if (n === "too_large_to_check_location") return this.$t("review.reason.tooLarge");
      return "";
    },
    // Without a live connection, refresh every few seconds while files process (for up to two minutes).
    schedulePoll() {
      clearTimeout(this.pollTimer);
      if (this.liveState === "open" || this.tab !== "files" || !this.files.some((f) => f.status === "processing")) return;
      if (!this.pollUntil) this.pollUntil = Date.now() + 120_000;
      if (Date.now() > this.pollUntil) return;
      this.pollTimer = setTimeout(() => this.loadFiles(), 3000);
    },
    decide(row, decision) {
      return this.run(() => api.libraries.review(this.org, this.lib, row.id, decision), this.$t(decision === "approve" ? "review.approved" : "review.rejected"));
    },
    reprocess(row) {
      this.pollUntil = 0;
      return this.run(() => api.libraries.reprocess(this.org, this.lib, row.id), this.$t("review.reprocessing"));
    },
    async download(row) {
      try {
        const blob = await api.download(this.org, this.lib, row.id);
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = row.name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
      } catch (e) {
        ElMessage.error(e.message || this.$t("errors.generic"));
      }
    },
    async run(fn, done) {
      try {
        await fn();
        if (done) ElMessage.success(done);
        await Promise.all([this.loadFiles(), this.loadUsage()]);
      } catch (e) {
        ElMessage.error(e.message || this.$t("errors.generic"));
      }
    },
    trash(row) {
      if (this.drawerFile?.id === row.id) this.drawerFile = null;
      return this.run(() => api.libraries.trashFile(this.org, this.lib, row.id), this.$t("upload.trashedMsg"));
    },
    restore(row) {
      return this.run(() => api.libraries.restoreFile(this.org, this.lib, row.id), this.$t("upload.restoredMsg"));
    },
    async purge(row) {
      try {
        await ElMessageBox.confirm(this.$t("upload.purgeConfirm", { name: row.name }), { type: "warning" });
      } catch {
        return;
      }
      return this.run(() => api.libraries.purgeFile(this.org, this.lib, row.id), this.$t("upload.purgedMsg"));
    },
  },
};
</script>

<style scoped>
.head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 12px;
}
.grow {
  flex: 1;
}
h1 {
  font-size: 1.5rem;
  margin: 0;
}
.presence {
  display: flex;
  padding-left: 6px;
}
.avatar {
  display: inline-grid;
  place-items: center;
  width: 28px;
  height: 28px;
  margin-left: -6px;
  border-radius: 50%;
  font-size: 0.7rem;
  font-weight: 600;
  color: #fff;
  background: var(--pv-brand);
  border: 2px solid var(--el-bg-color);
}
.avatar.more {
  background: var(--el-color-info);
}
.live-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--el-color-info);
}
.live-dot.open {
  background: var(--el-color-success);
}
.live-dot.closed {
  background: var(--el-color-warning);
}
.review-hint {
  margin-bottom: 8px;
}
.tags {
  font-size: 12px;
}
.usage {
  display: grid;
  gap: 4px;
  font-size: 0.85rem;
  max-width: 420px;
  margin-bottom: 16px;
}
.drop {
  display: grid;
  place-items: center;
  gap: 6px;
  padding: 28px 16px;
  border: 2px dashed var(--pv-border);
  cursor: pointer;
  text-align: center;
  transition: border-color 0.2s, background 0.2s;
}
.drop.over,
.drop:hover {
  border-color: var(--pv-brand);
  background: var(--pv-brand-soft);
}
.drop-icon {
  font-size: 2rem;
  color: var(--pv-brand);
}
.drop-title {
  font-weight: 600;
}
.opts {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  margin: 12px 0;
}
.btn-label {
  margin-left: 4px;
}
.queue {
  list-style: none;
  padding: 0;
  margin: 0 0 16px;
  display: grid;
  gap: 8px;
  max-height: 360px;
  overflow: auto;
}
.item {
  padding: 12px 16px;
}
.item-top {
  display: flex;
  justify-content: space-between;
  gap: 12px;
}
.item-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
}
.item-status {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.85rem;
  min-height: 24px;
}
.tabs {
  margin-top: 8px;
}
.browser {
  display: grid;
  grid-template-columns: 240px minmax(0, 1fr);
  gap: 16px;
  align-items: start;
}
.tree {
  padding: 8px;
  position: sticky;
  top: 12px;
  max-height: calc(100vh - 120px);
  overflow: auto;
}
.tree-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 4px 6px;
}
.tree-node {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.tree-label {
  overflow: hidden;
  text-overflow: ellipsis;
}
.crumbs {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 32px;
  flex-wrap: wrap;
}
.tree-toggle {
  display: none;
}
.toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  margin: 8px 0;
}
.search {
  flex: 1 1 220px;
  max-width: 360px;
}
.filter {
  width: 140px;
}
.select-all {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 8px;
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 12px;
}
.fname {
  overflow-wrap: anywhere;
}
.small {
  font-size: 0.78rem;
}
.more {
  text-align: center;
  margin-top: 12px;
}
@media (max-width: 760px) {
  .browser {
    grid-template-columns: minmax(0, 1fr);
  }
  .tree {
    display: none;
    position: static;
    max-height: none;
  }
  .tree.open {
    display: block;
  }
  .tree-toggle {
    display: inline-flex;
  }
  .filter {
    width: calc(50% - 4px);
  }
  .search {
    max-width: none;
  }
  .grid {
    grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
  }
}
</style>
