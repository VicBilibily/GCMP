import { defineConfig } from 'vite';
import vike from 'vike/plugin';
import react from '@vitejs/plugin-react';

// 纯静态站点（GitHub Pages）：全部页面构建时预渲染；
// 提供商配置数据源为 public/configs/（Vite publicDir 原生机制），构建时自动拷贝进产物
export default defineConfig({
    plugins: [vike(), react()]
});
