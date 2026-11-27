// Derived from MarSeventh/Sanyue-ImgHub@1621525:src/router/index.js (MIT), modified.
// The admin and user session-check guards become one guard on the Cirrus bearer session.
import { createRouter, createWebHistory } from "vue-router";
import store from "../store";

const routes = [
  { path: "/login", name: "login", component: () => import("../views/Login.vue"), meta: { public: true } },
  { path: "/onboarding", name: "onboarding", component: () => import("../views/Onboarding.vue") },
  { path: "/", name: "home", component: () => import("../views/Home.vue") },
  { path: "/o/:org/l/:lib/settings", name: "librarySettings", component: () => import("../views/SystemConfig.vue"), props: true },
  { path: "/:pathMatch(.*)*", name: "notFound", component: () => import("../views/NotFound.vue"), meta: { public: true } },
];

const router = createRouter({ history: createWebHistory(), routes });

let bootstrapped = false;

router.beforeEach(async (to) => {
  if (to.meta.public) return true;
  if (!store.getters.signedIn) return { name: "login", query: to.fullPath !== "/" ? { next: to.fullPath } : {} };
  if (!bootstrapped) {
    try {
      await store.dispatch("bootstrap");
      bootstrapped = true;
    } catch (e) {
      if (e?.status === 401) {
        store.commit("signOut");
        return { name: "login" };
      }
      throw e;
    }
  }
  if (to.name !== "onboarding" && store.state.orgs.length === 0 && store.state.guestLibraries.length === 0) {
    return { name: "onboarding" };
  }
  return true;
});

export function resetBootstrap() {
  bootstrapped = false;
}

export default router;
