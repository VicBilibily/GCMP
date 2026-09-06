import type { Config } from 'vike/types';
import vikeReact from 'vike-react/config';

export default {
    // GitHub Pages 纯静态托管：构建时预渲染全部页面为静态 HTML
    prerender: true,
    extends: [vikeReact]
} satisfies Config;
