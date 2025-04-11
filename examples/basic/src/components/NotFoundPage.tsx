export function NotFoundPage() {
  return (
    <div className="h-full flex items-center justify-center">
      <div className="bg-white p-8 max-w-md w-full text-center">
        <div className="mb-6">
          <h1 className="text-6xl font-bold">404</h1>
          <div className="w-16 h-1 mx-auto my-4"></div>
          <h2 className="text-2xl font-semibold text-gray-800">
            Page Not Found
          </h2>
        </div>

        <p className="text-gray-600 mb-8">
          The page you are looking for might have been removed, had its name
          changed, or is temporarily unavailable.
        </p>

        <a
          href="/"
          className="btn btn-primary w-full sm:w-fit"
          hx-boost="true"
        >
          Return Home
        </a>
      </div>
    </div>
  );
}
