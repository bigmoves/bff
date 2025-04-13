import type { JSX } from "preact";
import { cn } from "./utils.ts";

type Props =
  & JSX.HTMLAttributes<HTMLFormElement>
  & Readonly<{
    error?: string;
  }>;

export function Login(
  { error, ...rest }: Props,
) {
  return (
    <form
      id="login-form"
      hx-post="/oauth/login"
      hx-target="#login-form"
      hx-swap="outerHTML"
      {...rest}
      class={cn("tw:w-full tw:sm:max-w-[300px] tw:space-y-2", rest.class)}
    >
      <div>
        <label htmlFor="handle" class="tw:sr-only">
          Handle
        </label>
        <input
          id="handle"
          class="input"
          placeholder="Handle (e.g., user.bsky.social)"
          name="handle"
        />
      </div>
      <button id="submit" type="submit" class="btn btn-primary tw:w-full">
        Login with AT Protocol
      </button>
      <div className="tw:h-4">
        {error ? <div className="tw:text-sm tw:font-mono">{error}</div> : null}
      </div>
    </form>
  );
}
