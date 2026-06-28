// Activity card bootstrap: constructs the single ActivityCard instance and exposes its lifecycle on
// window. The shell (./activity-card) imports every class of the cluster (icons, model, and the
// journal/orrery/health views), so all are defined before `new ActivityCard()` runs here; the trailing
// window.mountActivity() self-call mounts it right away, and the offline path maps the embed through
// ActivityModel.toItem synchronously.
//
// window.mountActivity is the home's mount hook (home/home-view.ts showWelcome calls it);
// window.refreshActivityData is the SSE soft-reload hook (boot/bootstrap.ts). Both delegate to the
// single instance, and stay on window because those callers reach them cross-module through the global.

import { ActivityCard } from './activity-card';

export const activityCard = new ActivityCard();

window.mountActivity = () => activityCard.mount();
window.refreshActivityData = () => activityCard.refreshData();
window.mountActivity();
