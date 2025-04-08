type Props = Readonly<{
  error?: string;
}>;

export function Login({ error }: Props) {
  return (
    <form
      id="login-form"
      hx-post="/oauth/login"
      hx-target="#login-form"
      hx-swap="outerHTML"
      class="tw:w-full tw:sm:max-w-[300px] tw:space-y-2"
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
