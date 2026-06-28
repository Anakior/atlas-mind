// Activity card bootstrap — built LAST, once every class of the cluster is concatenated (same pattern
// as 16z-settings.ts). Concat = load order and `class` does not hoist: the shell (21-activity.ts) sorts
// FIRST so it only DEFINES ActivityCard, while this load-time `new ActivityCard()` runs mount() right
// away — and the offline path maps the embed through ActivityModel.toItem synchronously. Keeping the
// instantiation here, after 21a/21b (icons/model) and 21c/21d/21e (the views), guarantees every class
// is defined before it is used.
//
// mountActivity stays a global (10-home-layout's showWelcome calls it); refreshActivityData is the SSE
// soft-reload hook (99-bootstrap.ts). Both delegate to the single instance.
const activityCard = new ActivityCard();

window.mountActivity = () => activityCard.mount();
window.refreshActivityData = () => activityCard.refreshData();
window.mountActivity();
