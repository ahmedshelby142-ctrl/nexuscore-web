import { create } from "zustand";

export type StaffRole = "OWNER" | "MANAGER" | "CASHIER" | "VIEWER";
export type StaffStatus = "ACTIVE" | "PENDING";

export interface StaffMember {
  id: string;
  name: string;
  email: string;
  role: StaffRole;
  status: StaffStatus;
  invitedAt?: Date;
  joinedAt?: Date;
}

interface UsersState {
  staffMembers: StaffMember[];
  isLoading: boolean;
  
  fetchStaffMembers: () => Promise<void>;
  inviteUser: (email: string, role: StaffRole, name?: string) => Promise<void>;
  updateUserRole: (id: string, role: StaffRole) => Promise<void>;
  removeUser: (id: string) => Promise<void>;
}

// Mock initial data
const initialStaff: StaffMember[] = [
  {
    id: "user-1",
    name: "المالك الرئيسي",
    email: "owner@radiant.biz",
    role: "OWNER",
    status: "ACTIVE",
    joinedAt: new Date(),
  }
];

export const useUsersStore = create<UsersState>((set, get) => ({
  staffMembers: [...initialStaff],
  isLoading: false,

  fetchStaffMembers: async () => {
    // Simulate API delay
    set({ isLoading: true });
    await new Promise(resolve => setTimeout(resolve, 500));
    // In a real implementation, this would fetch from Supabase `store_members`
    set({ isLoading: false });
  },

  inviteUser: async (email: string, role: StaffRole, name?: string) => {
    set({ isLoading: true });
    await new Promise(resolve => setTimeout(resolve, 800));
    
    const newMember: StaffMember = {
      id: `user-${Date.now()}`,
      name: name || "مستخدم جديد",
      email,
      role,
      status: "PENDING",
      invitedAt: new Date(),
    };

    set(state => ({
      staffMembers: [...state.staffMembers, newMember],
      isLoading: false
    }));
  },

  updateUserRole: async (id: string, role: StaffRole) => {
    set({ isLoading: true });
    await new Promise(resolve => setTimeout(resolve, 500));
    
    set(state => ({
      staffMembers: state.staffMembers.map(member => 
        member.id === id ? { ...member, role } : member
      ),
      isLoading: false
    }));
  },

  removeUser: async (id: string) => {
    set({ isLoading: true });
    await new Promise(resolve => setTimeout(resolve, 500));
    
    set(state => ({
      staffMembers: state.staffMembers.filter(member => member.id !== id),
      isLoading: false
    }));
  }
}));
