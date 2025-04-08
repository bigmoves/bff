import { bff, CSS, oauth, RootProps } from "@bigmoves/bff";

bff({
  appName: "ATProto App",
  publicUrl: "",
  collections: [],
  rootElement: Root,
  middlewares: [
    oauth(),
    async (req, ctx) => {
      const { pathname } = new URL(req.url);

      if (pathname === "/") {
        return ctx.render(
          <div class="text-center">
            <h1 class="text-3xl font-bold">Hello from ATProto App</h1>
            {ctx.currentUser
              ? (
                <p class="mt-4">
                  @{ctx.currentUser?.handle}, welcome to your ATProto App!
                </p>
              )
              : null}
            {ctx.currentUser
              ? (
                <a href="/logout" hx-boost="true" class="underline">
                  Log out
                </a>
              )
              : (
                <a href="/login" hx-boost="true" class="underline">
                  Sign in
                </a>
              )}
          </div>,
        );
      }

      return ctx.next();
    },
  ],
});

function Root(props: RootProps) {
  return (
    <html lang="en" class="w-full h-full">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <script src="https://unpkg.com/htmx.org@1.9.10"></script>
        <style dangerouslySetInnerHTML={{ __html: CSS }} />
        <link rel="stylesheet" href="/static/styles.css" />
      </head>
      <body class="w-full h-full flex justify-center items-center">
        {props.children}
      </body>
    </html>
  );
}
