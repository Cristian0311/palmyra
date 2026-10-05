import { Building2, Trash2, X } from "lucide-react";
import { cn } from "../../lib/utils";
import type { Branch, User } from "../../types";

type Props = {
  user: User | null;
  branches: Branch[];
  employeeSalaries: Record<string, number>;
  setEmployeeSalaries: (value: Record<string, number>) => void;
  setUser: (user: User | null) => void;
  updateUser: (userId: string, changes: Partial<User>) => void;
  setUserToDelete: (value: { id: string; name: string } | null) => void;
  onClose: () => void;
};

export function SettingsEmployeeConfigModal({ user, branches, employeeSalaries, setEmployeeSalaries, setUser, updateUser, setUserToDelete, onClose }: Props) {
  if (!user) return null;
  return (
    <div className="fixed inset-0 bg-slate-950/40 dark:bg-slate-950/80 z-[100] flex items-center justify-center p-2 sm:p-4 overflow-y-auto">
      <div className="palmyra-mobile-modal bg-secondary w-full max-w-2xl rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[calc(100dvh-1rem)] border border-base">
        <div className="bg-rose-600 p-4 text-white flex items-center justify-between">
          <div><h3 className="text-xs font-black uppercase tracking-wider">Configuración de Empleado</h3><p className="text-[10px] font-bold text-rose-100 uppercase">{user.name}</p></div>
          <button type="button" onClick={onClose} className="p-1.5 hover:bg-white/10 rounded-lg" aria-label="Cerrar configuración"><X size={20}/></button>
        </div>
        <div className="p-4 sm:p-5 overflow-y-auto custom-scrollbar space-y-5 flex-1 bg-secondary">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="bg-subtle p-3.5 rounded-xl border border-base space-y-2">
              <span className="text-[8px] font-black text-muted uppercase tracking-widest block">Salario Base</span>
              <input type="number" min="0" step="0.01" value={employeeSalaries[user.id] ?? user.baseSalary ?? 0} onChange={e=>{const value=Number(e.target.value);setEmployeeSalaries({...employeeSalaries,[user.id]:value});updateUser(user.id,{baseSalary:value});}} className="w-full px-3 py-2 bg-primary border border-base rounded-lg text-xs font-black text-primary outline-none focus:ring-1 focus:ring-rose-500"/>
            </div>
            <div className="bg-subtle p-3.5 rounded-xl border border-base space-y-2">
              <span className="text-[8px] font-black text-muted uppercase tracking-widest block">Contraseña POS</span>
              <input type="password" value={user.password || ""} onChange={e=>{const password=e.target.value;setUser({...user,password});updateUser(user.id,{password});}} className="w-full px-3 py-2 bg-primary border border-base rounded-lg text-xs font-bold text-primary outline-none focus:ring-1 focus:ring-rose-500" placeholder="Nueva contraseña"/>
            </div>
          </div>
          <div className="bg-subtle p-4 rounded-xl border border-base space-y-3">
            <div className="flex items-center gap-2"><Building2 size={16} className="text-rose-600"/><h4 className="text-[10px] font-black text-primary uppercase">Acceso a almacenes</h4></div>
            <div className="grid gap-2 sm:grid-cols-2">
              {branches.map(branch=>{const isAllowed=user.allowedBranches?.includes(branch.id) ?? true;return <label key={branch.id} className={cn("flex items-center gap-2.5 p-2.5 rounded-xl border transition-all cursor-pointer",isAllowed?"bg-primary border-rose-200 dark:border-rose-500/50":"bg-subtle border-base opacity-40")}><input type="checkbox" checked={isAllowed} onChange={e=>{const current=user.allowedBranches ?? branches.map(b=>b.id);const allowed=e.target.checked?Array.from(new Set([...current,branch.id])):current.filter(id=>id!==branch.id);setUser({...user,allowedBranches:allowed});updateUser(user.id,{allowedBranches:allowed});}} className="w-4 h-4 rounded text-rose-600 focus:ring-rose-500"/><span className="text-[10px] font-black uppercase text-primary">{branch.name}</span></label>;})}
            </div>
          </div>
          <div className="pt-2 border-t border-base flex items-center justify-between">
            <button type="button" onClick={()=>{setUserToDelete({id:user.id,name:user.name});onClose();}} className="text-rose-600 hover:bg-rose-50 px-3 py-2 rounded-xl text-[10px] font-black uppercase flex items-center gap-1.5"><Trash2 size={14}/> Desactivar</button>
            <button type="button" onClick={onClose} className="bg-rose-600 text-white px-8 py-2.5 rounded-xl font-black text-[10px] uppercase shadow-md">Listo</button>
          </div>
        </div>
      </div>
    </div>
  );
}
