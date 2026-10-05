<script setup lang="ts">
withDefaults(defineProps<{ name: string; size?: number }>(), { size: 20 });
const paths: Record<string, string> = {
 dashboard: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
 orders: 'M6 4h12l2 17H4L6 4z M9 7V4a3 3 0 0 1 6 0v3',
 box: 'm3 7 9-4 9 4v10l-9 4-9-4V7z m0 0 9 4 9-4 M12 11v10 M7 5l10 4',
 chart: 'M4 3v17h17 M8 15l4-5 4 2 5-7',
 percent: 'M5 19 19 5 M8 5a3 3 0 1 0 0 .01 M16 16a3 3 0 1 0 0 .01',
 settings: 'M4 7h16 M4 17h16 M8 4v6 M16 14v6',
 sync: 'M20 7a9 9 0 0 0-15-2L3 7 M3 3v4h4 M4 17a9 9 0 0 0 15 2l2-2 M17 17h4v4',
 barcode: 'M3 7V3h4 M17 3h4v4 M21 17v4h-4 M7 21H3v-4 M7 7v10 M10 7v10 M14 7v10 M17 7v10',
 arrow: 'M5 12h14 M14 7l5 5-5 5', logout: 'M9 4H4v16h5 M10 12h11 M17 8l4 4-4 4',
 lock: 'M6 10h12v11H6z M8 10V6a4 4 0 0 1 8 0v4 M12 14v3',
 user: 'M16 7a4 4 0 1 0-8 0 4 4 0 0 0 8 0 M4 21v-2a8 8 0 0 1 16 0v2',
 eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z M15 12a3 3 0 1 0-6 0 3 3 0 0 0 6 0',
 menu: 'M4 6h16 M4 12h16 M4 18h16', check: 'm5 12 4 4L19 6',
};
</script>
<template><svg :width="size" :height="size" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path :d="paths[name] || paths.box" /></svg></template>
