<!-- Derived from MarSeventh/Sanyue-ImgHub@1621525:src/components/dashboard/BatchActionBar.vue (MIT), modified.
     Kept: the floating bar with the selection count and a clear button. Replaced: copy, download, tag, block and
     allow-list actions with what a library batch does (move, make public or private, delete), shown only to
     people whose role allows them. -->
<template>
  <transition name="bar">
    <div v-if="selectedCount > 0" class="bar pv-card" role="toolbar" :aria-label="$t('browse.selected', { n: selectedCount })" data-test="bulk-bar">
      <el-button text :aria-label="$t('browse.clear')" @click="$emit('clear')"><el-icon><Close /></el-icon></el-button>
      <span class="count">{{ $t("browse.selected", { n: selectedCount }) }}</span>
      <span class="divider" />
      <template v-if="canEdit">
        <el-button size="small" data-test="bulk-move" @click="$emit('action', 'move')"><el-icon><FolderOpened /></el-icon><span>{{ $t("browse.move") }}</span></el-button>
        <el-button size="small" data-test="bulk-collect" @click="$emit('action', 'collect')"><el-icon><Files /></el-icon><span>{{ $t("collections.add") }}</span></el-button>
        <el-button v-if="canPublish" size="small" data-test="bulk-public" @click="$emit('action', 'public')"><el-icon><View /></el-icon><span>{{ $t("browse.makePublic") }}</span></el-button>
        <el-button size="small" data-test="bulk-private" @click="$emit('action', 'private')"><el-icon><Hide /></el-icon><span>{{ $t("browse.makePrivate") }}</span></el-button>
      </template>
      <el-button v-if="canTrash" size="small" type="danger" plain data-test="bulk-trash" @click="$emit('action', 'trash')"><el-icon><Delete /></el-icon><span>{{ $t("upload.delete") }}</span></el-button>
    </div>
  </transition>
</template>

<script>
export default {
  name: "BatchActionBar",
  props: {
    selectedCount: { type: Number, required: true },
    canEdit: { type: Boolean, default: false },
    canPublish: { type: Boolean, default: true },
    canTrash: { type: Boolean, default: false },
  },
  emits: ["action", "clear"],
};
</script>

<style scoped>
.bar {
  position: sticky;
  bottom: 16px;
  z-index: 20;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  margin: 12px auto 0;
  width: fit-content;
  max-width: 100%;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.15);
}
.count {
  font-weight: 600;
}
.divider {
  width: 1px;
  height: 20px;
  background: var(--pv-border);
}
.bar .el-button span {
  margin-left: 4px;
}
.bar-enter-active,
.bar-leave-active {
  transition: opacity 0.15s, transform 0.15s;
}
.bar-enter-from,
.bar-leave-to {
  opacity: 0;
  transform: translateY(8px);
}
</style>
