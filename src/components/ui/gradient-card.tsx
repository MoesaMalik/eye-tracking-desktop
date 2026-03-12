import React from "react";

interface GradientCardProps {
  children: React.ReactNode;
  className?: string;
  gradient?: "none" | "subtle" | "blue" | "purple" | "green";
  animated?: boolean;
}

export const GradientCard: React.FC<GradientCardProps> = ({
  children,
  className = "",
  gradient = "subtle",
  animated = false,
}) => {
  const gradients = {
    none: "",
    subtle: "before:bg-gradient-to-br before:from-gray-50 before:to-gray-100/50",
    blue: "before:bg-gradient-to-br before:from-blue-50 before:to-indigo-50",
    purple: "before:bg-gradient-to-br before:from-purple-50 before:to-pink-50",
    green: "before:bg-gradient-to-br before:from-emerald-50 before:to-teal-50",
  };

  return (
    <div
      className={`
        group relative rounded-xl border border-gray-200 bg-white shadow-sm
        transition-all duration-300
        hover:shadow-md hover:-translate-y-0.5
        ${animated ? "animate-in fade-in slide-in-from-bottom-4 duration-500" : ""}
        ${className}
      `}
    >
      {/* Gradient background */}
      {gradient !== "none" && (
        <div
          className={`
            absolute inset-0 rounded-xl -z-10 opacity-0 group-hover:opacity-100 transition-opacity duration-300
            before:absolute before:inset-0 before:rounded-xl ${gradients[gradient]}
          `}
        />
      )}

      {/* Border glow effect */}
      <div className="absolute -inset-0.5 bg-gradient-to-r from-blue-500/0 via-purple-500/0 to-pink-500/0 group-hover:from-blue-500/20 group-hover:via-purple-500/20 group-hover:to-pink-500/20 rounded-xl opacity-0 group-hover:opacity-100 transition-opacity duration-500 blur -z-20" />

      {children}
    </div>
  );
};
