import React from "react";

interface ShimmerButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  children: React.ReactNode;
  shimmerColor?: string;
  variant?: "primary" | "secondary" | "success" | "danger";
}

export const ShimmerButton = React.forwardRef<HTMLButtonElement, ShimmerButtonProps>(
  ({ children, className = "", shimmerColor, variant = "primary", ...props }, ref) => {
    const variants = {
      primary: "bg-gray-900 text-white hover:bg-gray-800",
      secondary: "bg-blue-600 text-white hover:bg-blue-700",
      success: "bg-emerald-600 text-white hover:bg-emerald-700",
      danger: "bg-red-600 text-white hover:bg-red-700",
    };

    return (
      <button
        ref={ref}
        className={`
          group relative overflow-hidden rounded-lg px-4 py-2 font-medium
          transition-all duration-300 ease-in-out
          ${variants[variant]}
          shadow-sm hover:shadow-md
          transform hover:-translate-y-0.5 active:translate-y-0
          disabled:opacity-50 disabled:cursor-not-allowed disabled:transform-none
          ${className}
        `}
        {...props}
      >
        <span className="relative z-10 flex items-center gap-2">
          {children}
        </span>

        {/* Shimmer effect */}
        <div className="absolute inset-0 -translate-x-full group-hover:translate-x-full transition-transform duration-1000 ease-in-out">
          <div className="h-full w-1/2 bg-gradient-to-r from-transparent via-white/20 to-transparent skew-x-12" />
        </div>

        {/* Glow effect */}
        <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-300">
          <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/10 to-transparent" />
        </div>
      </button>
    );
  }
);

ShimmerButton.displayName = "ShimmerButton";
