<!-- Derived from MarSeventh/Sanyue-ImgHub@1621525:src/components/dashboard/FileCard.vue (MIT), modified.
     Kept: a card per file with a thumbnail, its name and a selection checkbox. Replaced: the channel badges, inline
     action menu and hover previews with the file's state and a click that opens the file drawer. Thumbnails come
     from serving's thumb preset for public images; other files show an icon for their type. -->
<template>
  <div class="card" :class="{ selected }" tabindex="0" role="button" :aria-label="file.name" data-test="file-card" @click="$emit('open', file)" @keydown.enter.prevent="$emit('open', file)">
    <div class="thumb">
      <img v-if="thumb" :src="thumb" :alt="file.name" loading="lazy" decoding="async" />
      <el-icon v-else class="type-icon"><component :is="icon" /></el-icon>
      <el-checkbox v-if="selectable" class="check" :model-value="selected" :aria-label="file.name" @click.stop @change="$emit('toggle', file)" />
      <el-tag v-if="statusType" class="state" size="small" :type="statusType">{{ $t(`status.${file.status}`) }}</el-tag>
    </div>
    <div class="name" :title="file.name">{{ file.name }}</div>
  </div>
</template>

<script>
import { fileKind, thumbUrl } from "@/utils/browse";

const ICONS = { image: "Picture", video: "VideoCamera", audio: "Headset", document: "Document", other: "Files" };

export default {
  name: "FileCard",
  props: {
    file: { type: Object, required: true },
    selected: { type: Boolean, default: false },
    selectable: { type: Boolean, default: false },
  },
  emits: ["open", "toggle"],
  computed: {
    thumb() {
      return thumbUrl(this.file);
    },
    icon() {
      return ICONS[fileKind(this.file.mime)];
    },
    statusType() {
      return { public: "success", processing: "info", held: "warning", flagged: "danger", removed: "danger" }[this.file.status] ?? null;
    },
  },
};
</script>

<style scoped>
.card {
  border: 1px solid var(--pv-border);
  border-radius: 10px;
  overflow: hidden;
  cursor: pointer;
  background: var(--pv-surface, transparent);
  transition: border-color 0.15s, box-shadow 0.15s;
}
.card:hover,
.card:focus-visible {
  border-color: var(--pv-brand);
  outline: none;
}
.card.selected {
  border-color: var(--pv-brand);
  box-shadow: 0 0 0 2px var(--pv-brand-soft);
}
.thumb {
  position: relative;
  aspect-ratio: 4 / 3;
  display: grid;
  place-items: center;
  background: var(--pv-brand-soft);
}
.thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.type-icon {
  font-size: 2.2rem;
  color: var(--pv-brand);
}
.check {
  position: absolute;
  top: 6px;
  left: 8px;
}
.state {
  position: absolute;
  right: 6px;
  bottom: 6px;
}
.name {
  padding: 6px 8px;
  font-size: 0.85rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
