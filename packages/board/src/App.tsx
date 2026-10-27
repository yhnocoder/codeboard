import { BoardView } from "./BoardView";
import { Chrome } from "./Chrome";

/** 插件里的整个白板页：白板本身，上面盖着操作栏 */
export function App() {
  return <BoardView><Chrome /></BoardView>;
}
