// What h(...) accepts as a child: a vnode, a primitive rendered as text, a falsy value
// that renders nothing, or an array of the same (flattened).
type Child = VNode | string | number | null | false | undefined | Child[];
