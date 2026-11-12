import { useMemo, useState, type ReactNode } from "react";
import type { Id } from "@aurora/schema";
import { parseMarkdown, type Block, type Inline } from "../markdown";

interface ContentContext {
  /** Nome de exibição de um usuário mencionado (`null` = não está no servidor). */
  nameOf: (userId: Id) => string | null;
  meId: Id;
  onOpenLink: (url: string) => void;
}

/** Spoiler: coberto até a pessoa clicar (ou Enter/Espaço). */
function Spoiler({ children }: { children: ReactNode }) {
  const [revealed, setRevealed] = useState(false);
  if (revealed) return <span className="md-spoiler md-spoiler--revealed">{children}</span>;
  return (
    <span
      className="md-spoiler"
      role="button"
      tabIndex={0}
      aria-label="Spoiler escondido. Clique para revelar."
      onClick={() => setRevealed(true)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          setRevealed(true);
        }
      }}
    >
      <span aria-hidden="true">{children}</span>
    </span>
  );
}

function renderInline(nodes: Inline[], ctx: ContentContext, keyPrefix: string): ReactNode[] {
  return nodes.map((node, index) => {
    const key = `${keyPrefix}${index}`;
    switch (node.type) {
      case "text":
        return node.text;
      case "br":
        return <br key={key} />;
      case "bold":
        return <strong key={key}>{renderInline(node.children, ctx, `${key}.`)}</strong>;
      case "italic":
        return <em key={key}>{renderInline(node.children, ctx, `${key}.`)}</em>;
      case "underline":
        return <u key={key}>{renderInline(node.children, ctx, `${key}.`)}</u>;
      case "strike":
        return <s key={key}>{renderInline(node.children, ctx, `${key}.`)}</s>;
      case "spoiler":
        return <Spoiler key={key}>{renderInline(node.children, ctx, `${key}.`)}</Spoiler>;
      case "code":
        return (
          <code key={key} className="md-code">
            {node.text}
          </code>
        );
      case "link":
        return (
          <a
            key={key}
            className="md-link"
            href={node.url}
            rel="noreferrer noopener"
            title={`Abrir no navegador: ${node.url}`}
            // nunca navegar dentro do app: o link abre no navegador padrão
            onClick={(event) => {
              event.preventDefault();
              ctx.onOpenLink(node.url);
            }}
            onAuxClick={(event) => event.preventDefault()}
          >
            {node.url}
          </a>
        );
      case "mention": {
        const name = ctx.nameOf(node.userId);
        const me = node.userId === ctx.meId;
        return (
          <span key={key} className={me ? "mention mention--me" : "mention"}>
            @{name ?? "alguém"}
          </span>
        );
      }
    }
  });
}

function renderBlock(block: Block, ctx: ContentContext, index: number, trailing: ReactNode): ReactNode {
  switch (block.type) {
    case "paragraph":
      return (
        <p key={index} className="md-paragraph">
          {renderInline(block.children, ctx, `${index}:`)}
          {trailing}
        </p>
      );
    case "quote":
      return (
        <blockquote key={index} className="md-quote">
          {renderInline(block.children, ctx, `${index}:`)}
          {trailing}
        </blockquote>
      );
    case "codeblock":
      return (
        <pre key={index} className="md-codeblock" data-lang={block.lang ?? undefined}>
          <code>{block.text}</code>
        </pre>
      );
  }
}

/** Corpo de uma mensagem com Markdown. `trailing` vai no fim do último parágrafo (ex.: "(editada)"). */
export function MessageContent({ content, trailing, ...ctx }: ContentContext & { content: string; trailing?: ReactNode }) {
  const blocks = useMemo(() => parseMarkdown(content), [content]);
  const last = blocks.at(-1);
  // "(editada)" no fim do último parágrafo; depois de um bloco de código, numa linha própria.
  const inline = last && last.type !== "codeblock";
  return (
    <div className="message__content">
      {blocks.map((block, index) => renderBlock(block, ctx, index, inline && index === blocks.length - 1 ? trailing : null))}
      {!inline && trailing}
    </div>
  );
}
