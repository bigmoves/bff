import type { JSX } from "preact";

export type MetaDescriptor =
  | { charSet: "utf-8" }
  | { title: string }
  | { name: string; content: string }
  | { property: string; content: string }
  | { tagName: "meta" | "link"; [name: string]: string }
  | { [name: string]: unknown };

export function Meta(
  { meta = [] }: Readonly<{ meta?: MetaDescriptor[] }>,
): JSX.Element {
  return (
    <>
      {meta.map((metaProps) => {
        if (!metaProps) {
          return null;
        }

        if ("title" in metaProps) {
          return <title key="title">{String(metaProps.title)}</title>;
        }

        if ("charset" in metaProps) {
          metaProps.charSet ??= metaProps.charset;
          delete metaProps.charset;
        }

        if ("charSet" in metaProps && metaProps.charSet != null) {
          return typeof metaProps.charSet === "string"
            ? <meta key="charSet" charSet={metaProps.charSet} />
            : null;
        }

        if ("tagName" in metaProps) {
          const { tagName, ...rest } = metaProps;
          if (!isValidMetaTag(tagName)) {
            console.warn(
              `A meta object uses an invalid tagName: ${tagName}. Expected either 'link' or 'meta'`,
            );
            return null;
          }
          const Comp = tagName;
          return <Comp key={JSON.stringify(rest)} {...rest} />;
        }

        return <meta key={JSON.stringify(metaProps)} {...metaProps} />;
      })}
    </>
  );
}

function isValidMetaTag(tagName: unknown): tagName is "meta" | "link" {
  return typeof tagName === "string" && /^(meta|link)$/.test(tagName);
}
