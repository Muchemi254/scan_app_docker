const LandingPage = () => {
  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-600 to-purple-700 flex items-center justify-center p-4">
      <div className="max-w-2xl w-full">
        <div className="text-center space-y-8">
          {/* Header */}
          <div>
            <h1 className="text-5xl md:text-6xl font-bold text-white mb-4">📋 Scan App</h1>
            <p className="text-xl md:text-2xl text-indigo-100">Receipt Scanning & Management</p>
          </div>

          {/* Features Grid */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 my-12">
            <div className="bg-white bg-opacity-10 backdrop-blur-md rounded-lg p-6 border border-white border-opacity-20">
              <div className="text-4xl mb-3">📸</div>
              <h3 className="text-lg font-semibold text-white mb-2">Scan Receipts</h3>
              <p className="text-indigo-100 text-sm">Capture and extract data from receipt images instantly</p>
            </div>

            <div className="bg-white bg-opacity-10 backdrop-blur-md rounded-lg p-6 border border-white border-opacity-20">
              <div className="text-4xl mb-3">📊</div>
              <h3 className="text-lg font-semibold text-white mb-2">Track Spending</h3>
              <p className="text-indigo-100 text-sm">Organize receipts by category and analyze spending patterns</p>
            </div>

            <div className="bg-white bg-opacity-10 backdrop-blur-md rounded-lg p-6 border border-white border-opacity-20">
              <div className="text-4xl mb-3">📈</div>
              <h3 className="text-lg font-semibold text-white mb-2">Generate Reports</h3>
              <p className="text-indigo-100 text-sm">Export detailed spending summaries and insights</p>
            </div>
          </div>

          {/* CTA Buttons */}
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <a
              href="/login"
              className="px-8 py-3 bg-white text-indigo-600 font-semibold rounded-lg hover:bg-indigo-50 transition-colors"
            >
              Sign In
            </a>
            <a
              href="/signup"
              className="px-8 py-3 bg-indigo-500 text-white font-semibold rounded-lg hover:bg-indigo-400 transition-colors border border-white border-opacity-20"
            >
              Create Account
            </a>
          </div>

          {/* Footer Info */}
          <div className="mt-12 text-indigo-100 text-sm">
            <p>Built with security and privacy in mind</p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default LandingPage;
