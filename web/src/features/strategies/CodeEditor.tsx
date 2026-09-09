import CodeMirror from '@uiw/react-codemirror';
import { javascript } from '@codemirror/lang-javascript';

/**
 * CodeMirror 6 JS 编辑器封装（D13 定稿 CodeMirror 6；批准依赖 @uiw/react-codemirror +
 * codemirror + @codemirror/lang-javascript）。
 * 语法高亮/行号由 basicSetup + lang-javascript 提供；「基本 lint」以保存前的轻量语法检查
 * （new Function 解析）兜底，不引入未批准的 @codemirror/lint 直依赖。
 */
export function CodeEditor({
  value,
  onChange,
  readOnly = false,
}: {
  value: string;
  onChange: (v: string) => void;
  readOnly?: boolean;
}) {
  return (
    <div className="h-full min-h-0 overflow-auto rounded-lg border border-line" data-testid="code-editor-wrap">
      <CodeMirror
        value={value}
        onChange={(v) => onChange(v)}
        theme="dark"
        height="100%"
        readOnly={readOnly}
        extensions={[javascript()]}
        basicSetup={{ lineNumbers: true, foldGutter: true, highlightActiveLine: true, autocompletion: false }}
      />
    </div>
  );
}

/** 轻量语法检查（new Function 仅解析不执行；SyntaxError → 错误描述，否则 null）。
 *  插件为「全局函数定义」脚本形态，包一层 function body 解析即可发现括号/语法错误。 */
export function checkSyntax(code: string): string | null {
  try {
    // 仅构造不调用：SyntaxError 在解析期抛出
    new Function(code);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : '语法错误';
  }
}
