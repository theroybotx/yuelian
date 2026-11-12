// Plan IDs describe the integration assertions exercised here. Browser and
// unit aspects of the same plan item must receive their own evidence.
export const coverage={
 api:{
  'AUTH-01':['AUTH-09','NAV-05','SEC-02'], 'AUTH-02':['SEC-01'],
  'AUTH-03':['SEC-01','SEC-10'], 'AUTH-04':['REL-03','REL-04'],
  'AUTH-05':['REL-05','REL-08','REL-09'], 'AUTH-06':['REL-12'],
  'TENANT-01':['SEC-02'], 'TENANT-02':['SEC-02','TX-01'],
  'TENANT-03':['SEC-03'], 'TENANT-04':['NAV-05','OP-09'],
  'TENANT-05':['SEC-03','BOUND-07'], 'TENANT-06':['SEC-04'],
  'TENANT-07':['SEC-05','OP-16'], 'PERM-01':['OP-07','SEC-06'],
  'PERM-02':['OP-09','SEC-06'], 'PERM-03':['REL-11','SEC-06'],
  'PERM-04':['REL-11','TX-04'], 'AI-04':['SEC-04','SEC-05','SEC-10'],
  'AI-05':['SEC-09','AI-11'], 'PLAN-01':['AI-04','TX-01'],
  'PLAN-02':['TX-01','SEC-06'], 'PLAN-03':['TX-04'],
  'PLAN-04':['TX-02'], 'PLAN-05':['FUN-09','TX-03'],
  'DB-01':['SEC-15'], 'DB-02':['SEC-15','SEC-16'],
  'DB-03':['SEC-16'], 'DB-04':['TX-13'],
  'EDGE-04':['SEC-11'], 'EDGE-06':['AI-10','SEC-14'],
  'EDGE-08':['BOUND-06','SEC-19'], 'INTEGRATION-03':['SEC-19'],
  'INTEGRATION-06':['TX-05','TX-06']
 },
 recovery:{
  'REC-01':['TX-07','TX-09'], 'REC-02':['TX-02','TX-08'],
  'REC-03':['TX-10'], 'REC-04':['TX-11'],
  'REC-05':['TX-04','TX-10'], 'REC-06':['TX-10'],
  'REC-07':['TX-11'], 'REC-08':['TX-12','UI-10'], 'REC-09':['TX-12','TX-13']
 },
 live:{
  'AI-01':['SEC-07'], 'AI-02':['SEC-08'],
  'AI-03':['SEC-07'], 'AI-06':['SEC-07'],
  'AI-LIVE-CHAIN':['AI-04'], 'AI-LIVE-SINGLE':['AI-02'],
  'AI-LIVE-VENUE':['AI-03'], 'AI-LIVE-INBOX':['AI-08'],
  'AI-LIVE-READS':['AI-12']
 }
};
