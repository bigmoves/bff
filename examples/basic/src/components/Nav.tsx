import { ProfileView } from "$lexicon/types/dev/fly/bffbasic/defs.ts";

export function Nav({ profile }: Readonly<{ profile?: ProfileView }>) {
  return (
    <nav className="w-full border-b border-slate-950 flex justify-between items-center px-4 h-14">
      <div className="flex items-center space-x-4">
        <a hx-boost="true" href="/">
          <h1 className="text-2xl font-semibold">
            <span className="text-sky-600">@</span> bff
          </h1>
        </a>
      </div>
      <div className="space-x-2">
        {profile
          ? (
            <div className="flex items-center space-x-2">
              <form hx-post="/logout" hx-swap="none" className="inline">
                <button type="submit" className="btn btn-link">Sign out</button>
              </form>
              <a href={`/profile/${profile.handle}`} hx-boost="true">
                <img
                  src={profile.avatar}
                  alt={profile.handle}
                  className="rounded-full h-8 w-8 object-cover"
                />
              </a>
            </div>
          )
          : (
            <div className="flex items-center space-x-4">
              <form hx-post="/signup" hx-swap="none" className="inline">
                <button type="submit" className="btn btn-link">
                  Create account
                </button>
              </form>
              <a
                hx-boost="true"
                href="/login"
                className="btn btn-link"
              >
                Sign in
              </a>
            </div>
          )}
      </div>
    </nav>
  );
}
