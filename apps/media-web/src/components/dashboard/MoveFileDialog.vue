<!-- Derived from MarSeventh/Sanyue-ImgHub@1621525:src/components/dashboard/MoveFileDialog.vue (MIT), modified.
     Kept: one dialog for moving a file or a selection, with a typed target path and a folder picker. Replaced: the
     separate mobile drawer (the dialog fits a phone) and the directory API with the library's folder tree. -->
<template>
  <el-dialog :model-value="visible" :title="title" width="min(480px, 92vw)" append-to-body @close="$emit('close')">
    <el-input v-model="target" :placeholder="$t('browse.targetPlaceholder')" data-test="move-target" @keydown.enter.prevent="confirm">
      <template #prepend><el-icon><Folder /></el-icon></template>
    </el-input>
    <p v-if="error" class="err small">{{ error }}</p>
    <el-tree class="picker" :data="tree" node-key="key" :props="{ label: 'label', children: 'children' }" default-expand-all :expand-on-click-node="false" highlight-current @node-click="pick" />
    <template #footer>
      <el-button @click="$emit('close')">{{ $t("browse.cancel") }}</el-button>
      <el-button type="primary" :loading="busy" data-test="move-confirm" @click="confirm">{{ $t("browse.moveHere") }}</el-button>
    </template>
  </el-dialog>
</template>

<script>
import { buildTree, normalizeFolderInput } from "@/utils/folders";

export default {
  name: "MoveFileDialog",
  props: {
    visible: { type: Boolean, default: false },
    title: { type: String, default: "" },
    folders: { type: Array, default: () => [] },
    current: { type: String, default: "/" },
    busy: { type: Boolean, default: false },
  },
  emits: ["close", "confirm"],
  data: () => ({ target: "/", error: "" }),
  computed: {
    tree() {
      const t = buildTree(this.folders, "/");
      const keyed = (n) => ({ ...n, key: n.path ?? "/", children: n.children.map(keyed) });
      return t.map(keyed);
    },
  },
  watch: {
    visible(v) {
      if (v) {
        this.target = this.current || "/";
        this.error = "";
      }
    },
  },
  methods: {
    pick(node) {
      this.target = node.path ?? "/";
    },
    confirm() {
      const f = normalizeFolderInput(this.target);
      if (f === null) {
        this.error = this.$t("browse.badFolder");
        return;
      }
      this.$emit("confirm", f);
    },
  },
};
</script>

<style scoped>
.picker {
  margin-top: 12px;
  max-height: 260px;
  overflow: auto;
  border: 1px solid var(--pv-border);
  border-radius: 8px;
  padding: 4px;
}
.err {
  color: var(--el-color-danger);
  margin: 6px 0 0;
}
.small {
  font-size: 0.8rem;
}
</style>
