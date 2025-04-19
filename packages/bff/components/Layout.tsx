import type { FunctionalComponent, JSX } from "preact";
import { Button } from "./Button.tsx";
import { cn } from "./utils.ts";

interface LayoutProps extends JSX.HTMLAttributes<HTMLDivElement> {
  children: preact.ComponentChildren;
}

interface LayoutContentProps extends JSX.HTMLAttributes<HTMLDivElement> {
  children: preact.ComponentChildren;
}

interface LayoutNavProps {
  title: string | preact.VNode;
  profile?: {
    handle: string;
    avatar?: string;
  };
}

const Layout: FunctionalComponent<LayoutProps> & {
  Content: FunctionalComponent<LayoutContentProps>;
  Nav: FunctionalComponent<LayoutNavProps>;
} = ({ children, ...props }) => {
  return (
    <div
      class="tw:h-full tw:max-w-5xl tw:mx-auto tw:sm:border-x tw:relative"
      {...props}
    >
      {children}
    </div>
  );
};

const LayoutContent: FunctionalComponent<LayoutContentProps> = (
  { children, class: classProp, ...props },
) => {
  return (
    <main
      class={cn("tw:h-[calc(100vh-56px)] tw:sm:overflow-y-auto", classProp)}
      {...props}
    >
      {children}
    </main>
  );
};

const LayoutNav: FunctionalComponent<LayoutNavProps> = ({ title, profile }) => {
  return (
    <nav class="tw:w-full tw:border-b tw:border-slate-950 tw:flex tw:justify-between tw:items-center tw:px-4 tw:h-14">
      <div class="tw:flex tw:items-center tw:space-x-4">
        <a hx-boost="true" href="/">
          <h1 class="tw:text-2xl tw:font-semibold">
            {title}
          </h1>
        </a>
      </div>
      <div class="tw:space-x-2">
        {profile
          ? (
            <div class="tw:flex tw:items-center tw:space-x-2">
              <form hx-post="/logout" hx-swap="none" class="inline">
                <button type="submit" class="btn btn-link">Sign out</button>
              </form>
              <a href={`/profile/${profile.handle}`} hx-boost="true">
                <img
                  src={profile.avatar}
                  alt={profile.handle}
                  class="tw:rounded-full tw:h-8 tw:w-8 tw:object-cover"
                />
              </a>
            </div>
          )
          : (
            <div class="tw:flex tw:items-center tw:space-x-4">
              <form hx-post="/signup" hx-swap="none" class="inline">
                <Button variant="secondary" type="submit">
                  Create account
                </Button>
              </form>
              <Button variant="secondary" asChild>
                <a hx-boost="true" href="/login">
                  Sign in
                </a>
              </Button>
            </div>
          )}
      </div>
    </nav>
  );
};

Layout.Content = LayoutContent;
Layout.Nav = LayoutNav;

export { Layout };
