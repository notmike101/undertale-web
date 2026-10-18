import javascript from '@notmike101/eslint-config-js';
import jsdoc from '@notmike101/eslint-config-jsdoc';

export default [
    { ignores: ['web/runtime/**', '.private/**'] },
    ...javascript,
    ...jsdoc,
];
