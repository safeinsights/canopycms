export default function Home() {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="text-center">
        <h1 className="text-4xl font-bold mb-4">CanopyCMS Test App</h1>
        <p className="text-gray-600 mb-8">
          This app is for Playwright E2E testing
        </p>
        <a
          href="/edit"
          className="bg-blue-600 text-white px-6 py-3 rounded-lg hover:bg-blue-700"
        >
          Open Editor
        </a>
      </div>
    </div>
  )
}
