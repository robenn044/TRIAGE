import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import Index from "./pages/Index.tsx";
import CameraAskAI from "./components/CameraAskAI.tsx";
import Itinerary from "./pages/Itinerary.tsx";
import Maps from "./pages/Maps.tsx";
import RobotDashboard from "./pages/RobotDashboard.tsx";
import PhoneLink from "./pages/PhoneLink.tsx";
import NotFound from "./pages/NotFound.tsx";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Index />} />
          <Route path="/dashboard" element={<CameraAskAI />} />
          <Route path="/robot" element={<RobotDashboard />} />
          <Route path="/link" element={<PhoneLink />} />
          <Route path="/itinerary" element={<Itinerary />} />
          <Route path="/maps" element={<Maps />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
