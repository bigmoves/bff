import { CSS, RootProps } from "@bigmoves/bff";
import { Nav } from "./components/Nav.tsx";
import { State } from "./main.tsx";

export function Root(props: RootProps<State>) {
  return (
    <html lang="en" class="w-full h-full">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <script src="https://unpkg.com/htmx.org@1.9.10" />
        <script src="https://unpkg.com/hyperscript.org@0.9.14" />
        <link
          rel="stylesheet"
          href="https://unpkg.com/@fortawesome/fontawesome-free@6.7.2/css/all.min.css"
          preload
        />
        <style dangerouslySetInnerHTML={{ __html: CSS }} />
        <link rel="stylesheet" href="/static/styles.css" />
      </head>
      <body class="h-full max-w-5xl mx-auto sm:border-x relative">
        <Nav profile={props.ctx.state.profile} />
        <main id="main" class="h-[calc(100vh-56px)] sm:overflow-y-auto px-4">
          {props.children}
        </main>
      </body>
    </html>
  );
}
