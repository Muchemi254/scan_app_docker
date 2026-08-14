// src/pages/SignupPage.tsx
// Self-service signup is intentionally closed: accounts are created by an
// administrator. This page explains that and links back to login.
import { Link } from 'react-router-dom';
import { ShieldCheck, LogIn } from 'lucide-react';

const SignupPage = () => {
  return (
    <div className="flex items-center justify-center min-h-screen bg-gray-100 px-4">
      <div className="bg-white p-8 rounded-xl shadow-lg w-full max-w-md space-y-6">
        <div className="text-center space-y-3">
          <div className="mx-auto w-14 h-14 rounded-full bg-blue-100 flex items-center justify-center">
            <ShieldCheck className="h-7 w-7 text-blue-600" />
          </div>
          <h2 className="text-2xl font-bold text-indigo-600">No Self-Service Signup</h2>
          <p className="text-sm text-gray-600 leading-relaxed">
            Accounts are created by an administrator. Please contact your system
            administrator to get an account.
          </p>
        </div>

        <Link
          to="/login"
          className="w-full flex items-center justify-center gap-2 bg-indigo-600 text-white py-2 rounded-md hover:bg-indigo-700 transition-colors"
        >
          <LogIn className="h-4 w-4" />
          Back to Login
        </Link>
      </div>
    </div>
  );
};

export default SignupPage;