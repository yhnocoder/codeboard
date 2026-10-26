// vite.config 的 ?script：单独打包好的脚本源码
declare module "*?script" {
  const code: string;
  export default code;
}

// 样式表只为副作用而引入（vite 处理），没有导出
declare module "*.css";
