import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSlug from "rehype-slug";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github-dark.css";

// Resolve a relative markdown link to an in-app /notes route.
function resolveHref(href: string | undefined, dir: string): string {
  if (!href) return "#";
  if (/^(https?:|mailto:|tel:|#)/i.test(href)) return href;
  const [p, hash] = href.split("#");
  const stack = dir ? dir.split("/") : [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") stack.pop();
    else stack.push(seg);
  }
  const out = stack.join("/").replace(/\.md$/i, "");
  return "/notes/" + out + (hash ? "#" + hash : "");
}

export function MarkdownView({ content, dir }: { content: string; dir: string }) {
  return (
    <div className="md-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSlug, rehypeHighlight]}
        components={{
          a({ href, children, ...props }) {
            const resolved = resolveHref(href, dir);
            const external = /^https?:/i.test(resolved);
            return (
              <a
                href={resolved}
                {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
                {...props}
              >
                {children}
              </a>
            );
          },
          table({ children }) {
            return (
              <div className="md-table-wrap">
                <table>{children}</table>
              </div>
            );
          },
          img({ src, alt }) {
            // eslint-disable-next-line @next/next/no-img-element
            return <img src={typeof src === "string" ? src : ""} alt={alt ?? ""} loading="lazy" />;
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
