import type { JSX } from "preact";

export type MetaProps = {
  title?: string;
  property?: string;
  content?: string;
  name?: string;
};

export function Meta(
  { meta = [] }: Readonly<{ meta?: MetaProps[] }>,
): JSX.Element {
  return (
    <>
      {meta.map((m) => {
        if ("title" in m) {
          return <title key="title">{m.title}</title>;
        }
        return <meta key={JSON.stringify(m)} {...m} />;
      })}
    </>
  );
}
