// vite.config 的 ?script：单独打包好的脚本源码
declare module "*?script" {
  const code: string;
  export default code;
}
